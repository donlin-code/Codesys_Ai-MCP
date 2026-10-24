# -*- coding: utf-8 -*-
"""Experimental SP20 ScriptEngine bridge; run only in a NEW isolated GUI IDE.

IronPython 2.7 compatible. No request may contain executable Python. The thread
dispatch mechanism follows the approach in luke-harriman/Codesys-MCP and the
local plcwright watcher; the protocol and handlers here are independent.
"""
from __future__ import print_function
import datetime
import hashlib
import io
import json
import os
import re
import sys
import time
import uuid
import xml.etree.ElementTree as ElementTree

PROTOCOL = 1
ACTIONS = ('ping', 'project_info', 'list', 'read', 'create_st', 'replace_st', 'compile')
UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
SHA_RE = re.compile(r'^[0-9a-f]{64}$')
MAX_REQUEST_BYTES = 4 * 1024 * 1024
try:
    text_type = unicode
except NameError:
    text_type = str


class BridgeError(Exception):
    def __init__(self, code, message, partial=False, details=None):
        Exception.__init__(self, message)
        self.code, self.partial, self.details = code, partial, details


def utc_now():
    return datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.%fZ')


def require_text(value, field):
    if not isinstance(value, text_type):
        raise BridgeError('INVALID_REQUEST', field + ' must be a string')
    if u'\x00' in value:
        raise BridgeError('INVALID_REQUEST', field + ' must not contain NUL')
    try:
        value.encode('utf-8', 'strict')
    except UnicodeError:
        raise BridgeError('INVALID_REQUEST', field + ' contains invalid Unicode')
    return value


def sha256(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def source_sha256(declaration, implementation):
    return sha256(declaration + u'\x00' + implementation)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def child_fingerprint(children):
    return sha256(canonical(sorted(children, key=lambda item: (item['name'], item['id']))))


def normalized_source(value, field):
    value = require_text(value, field)
    return value.replace(u'\r\n', u'\n').replace(u'\r', u'\n')


def requested_implementation(args):
    value = args.get('implementation')
    return normalized_source(u'' if value is None else value, 'implementation')


def path_segment(name):
    return name.replace(u'~', u'~0').replace(u'/', u'~1')


def object_segments(path):
    require_text(path, 'path')
    if path == '/':
        return []
    if not path.startswith('/') or path.endswith('/'):
        raise BridgeError('INVALID_PATH', 'Object paths must start with / and have no trailing /')
    parts = path[1:].split('/')
    if len(parts) > 128:
        raise BridgeError('PATH_TOO_DEEP', 'Object path exceeds the 128 segment limit')
    result = []
    for part in parts:
        selector = None
        # Names escape every literal tilde as ~0. An unescaped ~2 therefore
        # unambiguously introduces a full GUID selector, never a name suffix.
        if '~2' in part:
            part, selector = part.rsplit('~2', 1)
            if not re.match(r'\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z', selector):
                raise BridgeError('INVALID_PATH', 'Object selector must be a full GUID')
        if not part or re.search(r'~(?![01])', part):
            raise BridgeError('INVALID_PATH', 'Invalid escaped object name')
        result.append((part.replace('~1', '/').replace('~0', '~'), selector))
    return result


def parse_utc(value):
    require_text(value, 'timestamp')
    if not re.match(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$', value):
        raise BridgeError('INVALID_REQUEST', 'Timestamps must be UTC ISO 8601 with Z')
    try:
        return datetime.datetime.strptime(value, '%Y-%m-%dT%H:%M:%S.%fZ' if '.' in value else '%Y-%m-%dT%H:%M:%SZ')
    except ValueError:
        raise BridgeError('INVALID_REQUEST', 'Invalid UTC timestamp')


def validate_request(request, filename_id, ready, now=None):
    if not isinstance(request, dict):
        raise BridgeError('INVALID_REQUEST', 'Request must be an object')
    if not UUID_RE.match(filename_id) or request.get('id') != filename_id:
        raise BridgeError('IDENTITY_MISMATCH', 'Request UUID does not match its filename')
    for key in ('protocolVersion', 'sessionId', 'nonce', 'pid', 'projectIdentity'):
        if request.get(key) != ready[key]:
            raise BridgeError('IDENTITY_MISMATCH', 'Request identity differs: ' + key)
    if request.get('action') not in ACTIONS or not isinstance(request.get('args', {}), dict):
        raise BridgeError('INVALID_REQUEST', 'Unknown action or invalid args')
    if request.get('createdAt') is not None:
        parse_utc(request['createdAt'])
    if request.get('deadlineUtc') is not None:
        deadline = parse_utc(request['deadlineUtc'])
        if (now or datetime.datetime.utcnow()) >= deadline:
            raise BridgeError('EXPIRED', 'Request expired before IDE execution')
    return request


def read_json(path):
    if os.path.getsize(path) > MAX_REQUEST_BYTES:
        raise BridgeError('INVALID_REQUEST', 'JSON file exceeds the 4 MiB limit')
    with io.open(path, 'r', encoding='utf-8-sig') as handle:
        return json.load(handle)


def atomic_json(path, value):
    temporary = path + '.' + str(uuid.uuid4()) + '.tmp'
    with io.open(temporary, 'w', encoding='utf-8') as handle:
        handle.write(text_type(json.dumps(value, ensure_ascii=False, indent=2)))
        handle.flush()
    if sys.platform == 'cli':
        from System.IO import File
        if File.Exists(path):
            File.Replace(temporary, path, None)
        else:
            File.Move(temporary, path)
    else:
        os.replace(temporary, path)


def child_records(obj):
    return [{'name': text_type(child.get_name()), 'id': text_type(child.guid)}
            for child in obj.get_children(False)]


def resolve(project, path):
    obj = project
    inspected = 0
    for name, selector in object_segments(path):
        children = list(obj.get_children(False))
        inspected += len(children)
        if inspected > 20000:
            raise BridgeError('TREE_TOO_LARGE', 'Path lookup exceeds the 20000 inspected object limit')
        matches = [child for child in children if text_type(child.get_name()) == name
                   and (selector is None or text_type(child.guid).lower() == selector.lower())]
        if len(matches) != 1:
            raise BridgeError('OBJECT_NOT_UNIQUE', 'Expected exactly one object at ' + path)
        obj = matches[0]
    return obj


def source_metadata(obj):
    """Only PLCopen's own body tag identifies ST; textual also includes IL.

    A declaration of a graphical POU is readable but not its complete source.
    Export failure/unknown extensions conservatively disable ST replacement.
    """
    result = {'language': 'unknown', 'sourceKind': 'unknown',
              'sourceComplete': False, 'languageSource': 'unknown'}
    try:
        xml = text_type(obj.export_xml(recursive=False, declarations_as_plaintext=True))
        # IronPython 2.7's XML parser expects encoded bytes for non-ASCII/BOM input.
        root = ElementTree.fromstring(xml.encode('utf-8'))
        name = text_type(obj.get_name())
        local = lambda tag: tag.rsplit('}', 1)[-1].lower()
        kinds = {'datatype': 'DUT', 'globalvars': 'GVL', 'pou': 'POU',
                 'method': 'METHOD', 'action': 'ACTION', 'transition': 'TRANSITION'}
        matches = [node for node in root.iter()
                   if local(node.tag) in kinds and node.get('name') == name]
        if len(matches) != 1:
            return result
        node = matches[0]
        result['sourceKind'] = kinds[local(node.tag)]
        result['languageSource'] = 'plcopenxml'
        if result['sourceKind'] == 'POU' and node.get('pouType') in ('program', 'functionBlock', 'function'):
            result['pouType'] = node.get('pouType')
        if result['sourceKind'] in ('DUT', 'GVL'):
            result['sourceComplete'] = bool(getattr(obj, 'has_textual_declaration', False))
            return result
        bodies = [child for child in node if local(child.tag) == 'body']
        if len(bodies) == 1:
            languages = [local(child.tag).upper() for child in bodies[0]
                         if local(child.tag) in ('st', 'il', 'ld', 'fbd', 'sfc')]
            if len(languages) == 1:
                result['language'] = languages[0]
                result['sourceComplete'] = (languages[0] == 'ST'
                                           and bool(getattr(obj, 'has_textual_implementation', False)))
    except Exception as error:
        result['languageDetectionError'] = text_type(error)
    return result


def read_source(obj, path):
    has_declaration = bool(getattr(obj, 'has_textual_declaration', False))
    has_implementation = bool(getattr(obj, 'has_textual_implementation', False))
    if not has_declaration and not has_implementation:
        raise BridgeError('NOT_TEXTUAL', 'Object has no textual source: ' + path)
    declaration = text_type(obj.textual_declaration.text) if has_declaration else u''
    implementation = text_type(obj.textual_implementation.text) if has_implementation else u''
    result = {'path': path, 'id': text_type(obj.guid), 'declaration': declaration,
            'implementation': implementation, 'hasDeclaration': has_declaration,
            'hasImplementation': has_implementation,
            'text': declaration + (u'\n' + implementation if implementation else u''),
            'sha256': source_sha256(declaration, implementation), 'complete': True,
            'capturedAt': utc_now()}
    result.update(source_metadata(obj))
    return result


def collect_build_diagnostics(system):
    """Normalize CLR message fields before returning them over the JSON bridge."""
    diagnostics = []
    for category in system.get_message_categories():
        category_name = text_type(system.get_message_category_description(category))
        for message in system.get_message_objects(category):
            original_severity = text_type(message.severity)
            severity = ('error' if original_severity.lower() in ('error', 'fatal') else
                        'warning' if original_severity.lower() == 'warning' else 'info')
            message_text = text_type(message.text)
            diagnostics.append({
                'category': text_type(category), 'categoryName': category_name,
                'severity': severity, 'message': message_text,
                'originalSeverity': original_severity, 'text': message_text,
                'number': int(message.number) if message.number is not None else None,
                'prefix': text_type(message.prefix) if message.prefix is not None else None,
                'position': text_type(message.position_text) if message.position_text is not None else None,
                'object': text_type(message.object.get_name()) if message.object is not None else None})
    return diagnostics


class BoundBridge(object):
    def __init__(self, engine, project, config, pid):
        self.engine, self.project = engine, project
        self.path = os.path.normcase(os.path.abspath(text_type(project.path)))
        self.handle = int(project.handle)
        self.ready = {'protocolVersion': PROTOCOL, 'status': 'ready',
                      'sessionId': config['sessionId'], 'nonce': config['nonce'], 'pid': pid,
                      'projectIdentity': {'path': text_type(project.path), 'handle': self.handle,
                                          'instanceId': str(uuid.uuid4())},
                      'actions': list(ACTIONS), 'startedAt': utc_now(),
                      'adapter': 'experimental-sp20-scriptengine', 'officialMcp': False,
                      'isolatedTestProject': True}

    def assert_bound(self):
        current = self.engine.projects.primary
        if current is None or int(current.handle) != self.handle:
            raise BridgeError('PROJECT_CHANGED', 'Bound primary project was closed or replaced')
        current_path = os.path.normcase(os.path.abspath(text_type(current.path)))
        if current_path != self.path or int(self.project.handle) != self.handle:
            raise BridgeError('PROJECT_CHANGED', 'Bound project identity changed')

    def inventory(self):
        objects = []

        def walk(parent, parent_path, depth):
            children = list(parent.get_children(False))
            if children and depth >= 128:
                raise BridgeError('TREE_TOO_DEEP', 'Tree exceeds the 128 level limit',
                                  details={'parentPath': parent_path})
            if len(objects) + len(children) > 20000:
                raise BridgeError('TREE_TOO_LARGE', 'Tree exceeds the 20000 object limit')
            names, sibling_ids = {}, set()
            for child in children:
                name, identity = text_type(child.get_name()), text_type(child.guid)
                key = (name, identity.lower())
                if key in sibling_ids:
                    raise BridgeError('AMBIGUOUS_TREE', 'Duplicate sibling name and GUID',
                                      details={'parentPath': parent_path, 'name': name, 'id': identity})
                sibling_ids.add(key)
                names[name] = names.get(name, 0) + 1
            for child in children:
                name, identity = text_type(child.get_name()), text_type(child.guid)
                segment = path_segment(name)
                if names[name] > 1:
                    if not re.match(r'\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z', identity):
                        raise BridgeError('INVALID_OBJECT_ID', 'Duplicate names require full GUID identities',
                                          details={'parentPath': parent_path, 'name': name, 'id': identity})
                    segment += '~2' + identity
                path = ('' if parent_path == '/' else parent_path) + '/' + segment
                objects.append({'path': path, 'parentPath': parent_path, 'name': name, 'id': identity,
                                'typeGuid': text_type(child.type),
                                'isApplication': bool(getattr(child, 'is_application', False)),
                                'hasDeclaration': bool(getattr(child, 'has_textual_declaration', False)),
                                'hasImplementation': bool(getattr(child, 'has_textual_implementation', False)),
                                'childrenSha256': child_fingerprint(child_records(child))})
                if len(objects) > 20000:
                    raise BridgeError('TREE_TOO_LARGE', 'Tree exceeds the 20000 object limit')
                # The same GUID can occur in distinct hierarchy branches. Do
                # not prune or reject those appearances using a global set.
                walk(child, path, depth + 1)
        walk(self.project, '/', 0)
        return {'rootPath': '/', 'objects': objects, 'treeComplete': True,
                'inventorySha256': sha256(canonical(objects)),
                'rootChildrenSha256': child_fingerprint(child_records(self.project)), 'capturedAt': utc_now()}

    def replacement(self, obj, path, args, before=None, created=False):
        declaration = normalized_source(args.get('declaration'), 'declaration')
        implementation = requested_implementation(args)
        before = before or read_source(obj, path)
        if not before['sourceComplete'] or (before['language'] != 'ST' and before['sourceKind'] not in ('DUT', 'GVL')):
            raise BridgeError('UNSUPPORTED_LANGUAGE', 'ST replacement requires a confirmed ST body or a complete GVL/DUT declaration')
        if not before['hasDeclaration'] and declaration:
            raise BridgeError('NOT_TEXTUAL', 'Object cannot accept a declaration')
        if not before['hasImplementation'] and implementation:
            raise BridgeError('NOT_TEXTUAL', 'Object cannot accept an implementation')
        try:
            if before['hasDeclaration']:
                obj.textual_declaration.replace(new_text=declaration)
            if before['hasImplementation']:
                obj.textual_implementation.replace(new_text=implementation)
            after = read_source(obj, path)
            if after['declaration'] != declaration or after['implementation'] != implementation:
                raise BridgeError('READBACK_MISMATCH', 'IDE source differs from requested LF-normalized source', True, after)
            return {'created': created, 'verified': True, 'saved': False,
                    'beforeSha256': None if created else before['sha256'], 'readback': after}
        except BridgeError as exc:
            exc.partial = True
            raise
        except Exception as exc:
            try:
                details = read_source(obj, path)
            except Exception:
                details = {'path': path, 'readbackUnavailable': True}
            raise BridgeError('WRITE_FAILED', text_type(exc), True, details)

    def compile_application(self, application_path):
        application = resolve(self.project, application_path)
        if not bool(getattr(application, 'is_application', False)):
            raise BridgeError('INVALID_APPLICATION', 'Compile target must be an Application object')
        # rebuild() can return normally even with compiler errors. Clear stale
        # categories, run the complete rebuild, then inspect every diagnostic.
        system = self.engine.system
        for category in system.get_message_categories():
            system.clear_messages(category)
        returned, exception = False, None
        try:
            application.rebuild()
            returned = True
        except Exception as error:
            exception = text_type(error)
        self.assert_bound()
        diagnostics = collect_build_diagnostics(system)
        errors = sum(1 for item in diagnostics if item['severity'] == 'error')
        warnings = sum(1 for item in diagnostics if item['severity'] == 'warning')
        return {'applicationPath': application_path, 'fullBuild': True,
                'rebuildReturned': returned, 'success': returned and exception is None and errors == 0,
                'exception': exception, 'diagnostics': diagnostics,
                'errorCount': errors, 'warningCount': warnings,
                'saved': False, 'plcConnected': False, 'completedAt': utc_now()}

    def execute(self, request):
        validate_request(request, request['id'], self.ready)
        self.assert_bound()
        action, args = request['action'], request.get('args', {})
        if action == 'ping':
            return {'pong': True, 'projectIdentity': self.ready['projectIdentity'], 'capturedAt': utc_now()}
        if action == 'project_info':
            ide_version = None
            if sys.platform == 'cli':
                from System.Diagnostics import Process
                ide_version = text_type(Process.GetCurrentProcess().MainModule.FileVersionInfo.FileVersion)
            return {'projectIdentity': self.ready['projectIdentity'], 'projectPath': text_type(self.project.path),
                    'ideVersion': ide_version,
                    'primary': True, 'rootPath': '/', 'savedByBridge': False, 'capturedAt': utc_now()}
        if action == 'list':
            return self.inventory()
        if action == 'read':
            path = args.get('path')
            return read_source(resolve(self.project, path), path)
        if action == 'compile':
            if args.get('fullBuild') is not True:
                raise BridgeError('INVALID_REQUEST', 'compile requires fullBuild: true')
            return self.compile_application(args.get('applicationPath'))
        if action == 'replace_st':
            path = args.get('path')
            obj = resolve(self.project, path)
            before = read_source(obj, path)
            expected = args.get('expectedSha256')
            if not isinstance(expected, text_type) or not SHA_RE.match(expected):
                raise BridgeError('INVALID_REQUEST', 'expectedSha256 must be a SHA256 digest')
            if before['sha256'] != expected:
                raise BridgeError('CONFLICT', 'Source changed since baseline read', False, before)
            return self.replacement(obj, path, args, before)
        if action == 'create_st':
            parent_path = args.get('parentPath')
            parent = resolve(self.project, parent_path)
            name = require_text(args.get('name'), 'name')
            if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', name):
                raise BridgeError('INVALID_REQUEST', 'Creation requires an ASCII IEC identifier')
            kind = args.get('kind')
            if kind not in ('PROGRAM', 'FUNCTION_BLOCK', 'GVL', 'DUT', 'METHOD', 'ACTION'):
                raise BridgeError('INVALID_REQUEST', 'Unsupported object kind')
            # Validate all source fields before any creation side effects.
            declaration = normalized_source(args.get('declaration'), 'declaration')
            implementation = requested_implementation(args)
            if kind in ('GVL', 'DUT') and implementation:
                raise BridgeError('INVALID_REQUEST', 'GVL and DUT do not have implementations')
            if kind == 'ACTION' and declaration:
                raise BridgeError('INVALID_REQUEST', 'ACTION has no declaration; submit an empty string')
            children = child_records(parent)
            if args.get('expectedChildrenSha256') != child_fingerprint(children):
                raise BridgeError('CONFLICT', 'Parent children changed or baseline is missing')
            if any(child['name'].lower() == name.lower() for child in children):
                raise BridgeError('ALREADY_EXISTS', 'An object with this name already exists')
            if kind == 'METHOD':
                parent_source = read_source(parent, parent_path)['declaration']
                if not re.search(r'(?im)^\s*FUNCTION_BLOCK\s+', parent_source):
                    raise BridgeError('INVALID_PARENT', 'METHOD requires a function block parent')
            if kind == 'ACTION':
                parent_metadata = source_metadata(parent)
                if parent_metadata.get('sourceKind') != 'POU' or parent_metadata.get('pouType') not in ('program', 'functionBlock'):
                    raise BridgeError('INVALID_PARENT', 'ACTION requires a PLCopen-confirmed PROGRAM or FUNCTION_BLOCK parent')
            path = ('' if parent_path == '/' else parent_path) + '/' + path_segment(name)
            try:
                if kind in ('PROGRAM', 'FUNCTION_BLOCK'):
                    pou_type = self.engine.PouType.Program if kind == 'PROGRAM' else self.engine.PouType.FunctionBlock
                    obj = parent.create_pou(name=name, type=pou_type, language=self.engine.ImplementationLanguages.st)
                elif kind == 'GVL':
                    obj = parent.create_gvl(name)
                elif kind == 'DUT':
                    obj = parent.create_dut(name, self.engine.DutType.Structure)
                elif kind == 'ACTION':
                    obj = parent.create_action(name=name, language=self.engine.ImplementationLanguages.st)
                else:
                    obj = parent.create_method(name=name, language=self.engine.ImplementationLanguages.st)
                obj = resolve(self.project, path) if obj is None else obj
                return self.replacement(obj, path, args, created=True)
            except BridgeError as exc:
                exc.partial = True
                raise
            except Exception as exc:
                raise BridgeError('CREATE_FAILED', text_type(exc), True, {'path': path})
        raise BridgeError('INVALID_REQUEST', 'Action is unavailable')

    def respond(self, request, filename_id):
        response = {key: self.ready[key] for key in ('protocolVersion', 'sessionId', 'nonce', 'pid', 'projectIdentity')}
        response['id'] = filename_id
        try:
            validate_request(request, filename_id, self.ready)
            response.update({'ok': True, 'result': self.execute(request)})
        except Exception as exc:
            response.update({'ok': False, 'error': {'code': getattr(exc, 'code', 'IDE_ERROR'),
                             'message': text_type(exc), 'partial': getattr(exc, 'partial', False),
                             'details': getattr(exc, 'details', None)}})
        response['completedAt'] = utc_now()
        return response


def validate_bootstrap(config):
    if not isinstance(config, dict) or config.get('protocolVersion') != PROTOCOL:
        raise BridgeError('INVALID_BOOTSTRAP', 'Expected protocolVersion 1')
    for key in ('sessionId', 'nonce', 'ipcDirectory', 'projectPath'):
        require_text(config.get(key), key)
    if not UUID_RE.match(config['sessionId']) or len(config['nonce']) < 32:
        raise BridgeError('INVALID_BOOTSTRAP', 'Expected UUID sessionId and nonce of at least 32 characters')
    if config.get('mode') not in ('create', 'open') or config.get('isolatedTestProject') is not True:
        raise BridgeError('INVALID_BOOTSTRAP', 'Only isolated test project create/open is supported')
    for key in ('ipcDirectory', 'projectPath'):
        if not os.path.isabs(config[key]):
            raise BridgeError('INVALID_BOOTSTRAP', key + ' must be absolute')
    sandbox = os.path.normcase(os.path.realpath(os.path.join(os.path.dirname(__file__), '..', 'artifacts')))
    project = os.path.normcase(os.path.realpath(config['projectPath']))
    if not project.startswith(sandbox + os.sep) or not project.lower().endswith('.project'):
        raise BridgeError('INVALID_BOOTSTRAP', 'Experimental bridge projects must be below this repository artifacts directory')
    return config


def start(config):
    import clr
    import scriptengine as se
    from System import GC, IntPtr
    from System.Diagnostics import Process
    from System.Threading import Thread, ThreadStart, ManualResetEvent
    validate_bootstrap(config)
    directory = config['ipcDirectory']
    if not os.path.isdir(directory):
        os.makedirs(directory)
    # Never reuse an IPC session after a crash; this avoids replaying uncertain writes.
    lock = os.open(os.path.join(directory, 'session.lock'), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.close(lock)
    if se.projects.primary is not None:
        raise BridgeError('EXISTING_PROJECT', 'Start a new IDE with no primary project')
    path = config['projectPath']
    if config['mode'] == 'create':
        if os.path.exists(path):
            raise BridgeError('ALREADY_EXISTS', 'Refusing to overwrite an existing project')
        project = se.projects.create(path, primary=True)
    else:
        if not os.path.isfile(path):
            raise BridgeError('NOT_FOUND', 'Independent project copy does not exist')
        project = se.projects.open(path, primary=True,
                    update_flags=se.VersionUpdateFlags.NoUpdates | se.VersionUpdateFlags.SilentMode)
    bridge = BoundBridge(se, project, config, Process.GetCurrentProcess().Id)
    bridge.assert_bound()

    def dispatch(callback):
        done = ManualResetEvent(False)
        state = {}
        def invoke():
            try:
                state['result'] = callback()
            except Exception as exc:
                state['error'] = exc
            finally:
                done.Set()
        # Positional True selects SP20's async overload, leaving the worker free
        # to report an unknown outcome. Callback checks deadline before any write.
        se.system.execute_on_primary_thread(invoke, True)
        if not done.WaitOne(120000):
            raise BridgeError('EXECUTION_UNKNOWN', 'Primary thread did not finish within 120 seconds', True)
        if 'error' in state:
            raise state['error']
        return state.get('result')

    def log(message):
        with io.open(os.path.join(directory, 'bridge.log'), 'a', encoding='utf-8') as handle:
            handle.write(utc_now() + u' ' + text_type(message) + u'\n')

    def worker():
        try:
            # Startup script has returned and primary-thread dispatch is proven.
            dispatch(bridge.assert_bound)
            atomic_json(os.path.join(directory, 'ready.json'), bridge.ready)
            log('ready')
            while True:
                stop_path = os.path.join(directory, 'stop.json')
                if os.path.isfile(stop_path):
                    stop = read_json(stop_path)
                    if stop.get('sessionId') == config['sessionId'] and stop.get('nonce') == config['nonce']:
                        log('worker stopped; IDE and project left open')
                        return
                process = Process.GetCurrentProcess()
                process.Refresh()
                if process.MainWindowHandle == IntPtr.Zero:
                    log('IDE window closed; worker stopped')
                    return
                names = [name for name in os.listdir(directory) if name.endswith('.req.json') and UUID_RE.match(name[:-9])]
                names.sort(key=lambda name: (os.path.getmtime(os.path.join(directory, name)), name))
                for name in names:
                    request_id = name[:-9]
                    output = os.path.join(directory, request_id + '.res.json')
                    if os.path.exists(output):
                        continue
                    request = read_json(os.path.join(directory, name))
                    # Mark every started operation durably. Never retry after an
                    # ambiguous timeout; only read-only client reconciliation is safe.
                    atomic_json(os.path.join(directory, request_id + '.started.json'), {'id': request_id, 'startedAt': utc_now()})
                    try:
                        response = dispatch(lambda: bridge.respond(request, request_id))
                    except BridgeError as exc:
                        response = {key: bridge.ready[key] for key in ('protocolVersion', 'sessionId', 'nonce', 'pid', 'projectIdentity')}
                        response.update({'id': request_id, 'ok': False, 'completedAt': utc_now(),
                                         'error': {'code': exc.code, 'message': text_type(exc), 'partial': exc.partial}})
                        atomic_json(output, response)
                        # A queued callback may still complete. Stop dispatching
                        # after unknown execution; no subsequent write can race it.
                        if exc.code == 'EXECUTION_UNKNOWN':
                            log('execution unknown; worker stopped; inspect IDE before restarting')
                            return
                    atomic_json(output, response)
                Thread.Sleep(100)
        except Exception as exc:
            log('worker failed: ' + text_type(exc))
            atomic_json(os.path.join(directory, 'worker-error.json'), {'ok': False, 'error': text_type(exc), 'completedAt': utc_now()})

    thread = Thread(ThreadStart(worker))
    thread.IsBackground = False
    thread.Start()
    GC.KeepAlive(thread)
    return bridge


if __name__ == '__main__':
    configuration = None
    try:
        if len(sys.argv) != 2:
            raise BridgeError('INVALID_BOOTSTRAP', 'Pass exactly one bootstrap JSON filename via --scriptargs')
        configuration = read_json(sys.argv[1])
        start(configuration)
    except Exception as error:
        if isinstance(configuration, dict) and os.path.isdir(configuration.get('ipcDirectory', '')):
            atomic_json(os.path.join(configuration['ipcDirectory'], 'startup-error.json'),
                        {'ok': False, 'error': text_type(error), 'completedAt': utc_now()})
        raise
