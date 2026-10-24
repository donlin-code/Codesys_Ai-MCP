# -*- coding: utf-8 -*-
"""Pure bridge contract tests, with a deliberately small ScriptEngine double.

This does not claim native IDE or multithread runtime acceptance.
Run: python tests/sp20-bridge-contract.py
"""
import copy
import importlib.util
import os
import unittest
import uuid
from xml.sax.saxutils import escape
from types import SimpleNamespace

SCRIPT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'scripts', 'sp20_bridge.py'))
SPEC = importlib.util.spec_from_file_location('sp20_bridge', SCRIPT)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class Document:
    def __init__(self, text=''):
        self.text = text
        self.fail = False
        self.alter = False
        self.writes = 0

    def replace(self, *, new_text):
        self.writes += 1
        if self.fail:
            raise RuntimeError('Injected editor failure')
        self.text = new_text + (' ' if self.alter else '')


class Object:
    def __init__(self, name, declaration=None, implementation=None):
        self.name, self.guid, self.type = name, str(uuid.uuid4()), 'type-guid'
        self.children = []
        self.has_textual_declaration = declaration is not None
        self.has_textual_implementation = implementation is not None
        self.textual_declaration = Document(declaration or '')
        self.textual_implementation = Document(implementation or '')
        self.language = 'ST'
        self.xml_tag = 'pou'
        self.pou_type = {'PROGRAM': 'program', 'FUNCTION_BLOCK': 'functionBlock',
                         'FUNCTION': 'function'}.get((declaration or '').split(' ', 1)[0], '')
        self.action_creations = 0

    def get_name(self):
        return self.name

    def get_children(self, recursive=False):
        assert recursive is False
        return self.children

    def export_xml(self, **kwargs):
        if self.has_textual_implementation:
            return ('<project><' + self.xml_tag + ' name="' + escape(self.name) + '" pouType="' + self.pou_type
                    + '"><body><' + self.language + '/></body></' + self.xml_tag + '></project>')
        tag = 'globalVars' if self.textual_declaration.text.startswith('VAR_GLOBAL') else 'dataType'
        return '<project><' + tag + ' name="' + escape(self.name) + '"/></project>'

    def create_pou(self, *, name, type, language):
        assert language == 'ST'
        obj = Object(name, type + ' ' + name, '')
        self.children.append(obj)
        return obj

    def create_gvl(self, name):
        obj = Object(name, 'VAR_GLOBAL\nEND_VAR')
        self.children.append(obj)
        return obj

    def create_dut(self, name, kind):
        assert kind == 'Structure'
        obj = Object(name, 'TYPE ' + name)
        self.children.append(obj)
        return obj

    def create_method(self, *, name, language):
        return self.create_pou(name=name, type='METHOD', language=language)

    def create_action(self, *, name, language):
        assert language == 'ST'
        self.action_creations += 1
        obj = Object(name, implementation='')
        obj.xml_tag = 'action'
        self.children.append(obj)
        return obj


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.project = Object('root')
        self.project.path = os.path.abspath('artifacts/contract-test.project')
        self.project.handle = 77
        self.code = Object('PLC_PRG', 'PROGRAM PLC_PRG\nVAR\nEND_VAR\n', 'x := 1;\n')
        self.project.children.append(self.code)
        self.engine = SimpleNamespace(projects=SimpleNamespace(primary=self.project),
                                      PouType=SimpleNamespace(Program='PROGRAM', FunctionBlock='FUNCTION_BLOCK'),
                                      DutType=SimpleNamespace(Structure='Structure'),
                                      ImplementationLanguages=SimpleNamespace(st='ST'))
        self.config = {'sessionId': str(uuid.uuid4()), 'nonce': 'n' * 32}
        self.session = bridge.BoundBridge(self.engine, self.project, self.config, 1234)

    def request(self, action, args=None, **extra):
        req = {key: self.session.ready[key] for key in ('protocolVersion', 'sessionId', 'nonce', 'pid', 'projectIdentity')}
        req.update(id=str(uuid.uuid4()), action=action, args=args or {})
        req.update(extra)
        return req

    def invoke(self, action, args=None, **extra):
        req = self.request(action, args, **extra)
        return self.session.respond(req, req['id'])

    def test_read_retains_exact_unicode_and_newline_hash(self):
        self.code.textual_declaration.text = 'PROGRAM PLC_PRG\r\n(* 气缸 *)\r\n'
        result = self.invoke('read', {'path': '/PLC_PRG'})['result']
        self.assertEqual(result['declaration'], self.code.textual_declaration.text)
        self.assertEqual(result['text'], result['declaration'] + '\n' + result['implementation'])
        self.assertEqual(result['sha256'], bridge.sha256(result['declaration'] + '\0' + result['implementation']))
        self.assertEqual(self.code.textual_declaration.writes, 0)

    def test_identity_guards_never_write(self):
        for key, value in [('sessionId', str(uuid.uuid4())), ('nonce', 'wrong'), ('pid', 44),
                           ('projectIdentity', {'path': self.project.path, 'handle': 77})]:
            result = self.invoke('replace_st', {'path': '/PLC_PRG'}, **{key: value})
            self.assertFalse(result['ok'])
            self.assertEqual(result['error']['code'], 'IDENTITY_MISMATCH')
        self.assertEqual(self.code.textual_declaration.writes, 0)

    def test_filename_uuid_mismatch(self):
        req = self.request('ping')
        self.assertFalse(self.session.respond(req, str(uuid.uuid4()))['ok'])

    def test_expired_write_never_executes(self):
        result = self.invoke('replace_st', {'path': '/PLC_PRG'}, deadlineUtc='2000-01-01T00:00:00Z')
        self.assertEqual(result['error']['code'], 'EXPIRED')
        self.assertEqual(self.code.textual_declaration.writes, 0)

    def test_changed_project_is_rejected_even_at_same_path(self):
        changed = copy.copy(self.project)
        changed.handle = 88
        self.engine.projects.primary = changed
        self.assertEqual(self.invoke('read', {'path': '/PLC_PRG'})['error']['code'], 'PROJECT_CHANGED')

    def test_stale_hash_does_not_write(self):
        result = self.invoke('replace_st', {'path': '/PLC_PRG', 'expectedSha256': '0' * 64,
                                          'declaration': 'PROGRAM PLC_PRG', 'implementation': 'x:=2;'})
        self.assertEqual(result['error']['code'], 'CONFLICT')
        self.assertEqual(self.code.textual_declaration.writes, 0)

    def test_replace_exact_readback_and_explicit_input_lf(self):
        before = self.invoke('read', {'path': '/PLC_PRG'})['result']
        result = self.invoke('replace_st', {'path': '/PLC_PRG', 'expectedSha256': before['sha256'],
                                          'declaration': before['declaration'], 'implementation': 'x:=2;\r\n'})
        self.assertTrue(result['ok'])
        self.assertEqual(result['result']['readback']['implementation'], 'x:=2;\n')
        self.assertFalse(result['result']['saved'])

    def test_partial_write_is_not_success(self):
        before = self.invoke('read', {'path': '/PLC_PRG'})['result']
        self.code.textual_implementation.fail = True
        result = self.invoke('replace_st', {'path': '/PLC_PRG', 'expectedSha256': before['sha256'],
                                          'declaration': 'PROGRAM PLC_PRG\n(* changed *)', 'implementation': 'x:=2;'})
        self.assertFalse(result['ok'])
        self.assertTrue(result['error']['partial'])
        self.assertEqual(result['error']['details']['implementation'], 'x := 1;\n')

    def test_readback_preserves_difference_in_whitespace(self):
        before = self.invoke('read', {'path': '/PLC_PRG'})['result']
        self.code.textual_implementation.alter = True
        result = self.invoke('replace_st', {'path': '/PLC_PRG', 'expectedSha256': before['sha256'],
                                          'declaration': before['declaration'], 'implementation': 'x:=2;'})
        self.assertEqual(result['error']['code'], 'READBACK_MISMATCH')
        self.assertTrue(result['error']['partial'])

    def test_create_requires_current_parent_baseline(self):
        args = {'parentPath': '/', 'name': 'NewFB', 'kind': 'FUNCTION_BLOCK',
                'declaration': 'FUNCTION_BLOCK NewFB\nVAR\nEND_VAR\n', 'implementation': ''}
        self.assertEqual(self.invoke('create_st', args)['error']['code'], 'CONFLICT')
        args['expectedChildrenSha256'] = self.invoke('list')['result']['rootChildrenSha256']
        self.assertTrue(self.invoke('create_st', args)['ok'])
        self.assertEqual(self.invoke('create_st', args)['error']['code'], 'CONFLICT')

    def test_method_parent_and_gvl_implementation_rejected_before_create(self):
        baseline = self.invoke('list')['result']['objects'][0]['childrenSha256']
        method = {'parentPath': '/PLC_PRG', 'expectedChildrenSha256': baseline, 'name': 'BadMethod',
                  'kind': 'METHOD', 'declaration': 'METHOD BadMethod', 'implementation': ''}
        self.assertEqual(self.invoke('create_st', method)['error']['code'], 'INVALID_PARENT')
        self.assertEqual(self.code.children, [])
        method.update(parentPath='/', name='BadGVL', kind='GVL', implementation='x:=1;')
        self.assertEqual(self.invoke('create_st', method)['error']['code'], 'INVALID_REQUEST')

    def action_args(self, parent, path, declaration='', implementation='x := 2;\n'):
        return {'parentPath': path, 'expectedChildrenSha256': bridge.child_fingerprint(bridge.child_records(parent)),
                'name': 'ACT_Init', 'kind': 'ACTION', 'declaration': declaration, 'implementation': implementation}

    def test_create_action_under_program_and_function_block_has_no_declaration(self):
        for pou_type in ('program', 'functionBlock'):
            with self.subTest(pou_type=pou_type):
                self.code.pou_type = pou_type
                self.code.children = []
                args = self.action_args(self.code, '/PLC_PRG', implementation='(* 初始化 *)\r\nx := 2;\r\n')
                response = self.invoke('create_st', args)
                self.assertTrue(response['ok'])
                result = response['result']
                readback = result['readback']
                self.assertTrue(result['created'])
                self.assertTrue(result['verified'])
                self.assertFalse(result['saved'])
                self.assertEqual(readback['path'], '/PLC_PRG/ACT_Init')
                self.assertEqual(readback['sourceKind'], 'ACTION')
                self.assertEqual(readback['language'], 'ST')
                self.assertTrue(readback['sourceComplete'])
                self.assertFalse(readback['hasDeclaration'])
                self.assertEqual(readback['declaration'], '')
                self.assertEqual(readback['implementation'], '(* 初始化 *)\nx := 2;\n')
                self.assertEqual(self.code.children[0].textual_declaration.writes, 0)

    def test_action_declaration_and_invalid_implementation_reject_before_create(self):
        for declaration in ('ACTION ACT_Init', ' ', '\n'):
            with self.subTest(declaration=declaration):
                result = self.invoke('create_st', self.action_args(self.code, '/PLC_PRG', declaration))
                self.assertEqual(result['error']['code'], 'INVALID_REQUEST')
                self.assertFalse(result['error']['partial'])
        result = self.invoke('create_st', self.action_args(self.code, '/PLC_PRG', implementation=7))
        self.assertEqual(result['error']['code'], 'INVALID_REQUEST')
        self.assertEqual(self.code.action_creations, 0)
        self.assertEqual(self.code.children, [])

    def test_action_parent_requires_plcopen_pou_type_not_declaration_text(self):
        for xml_tag, pou_type in [('pou', 'function'), ('pou', ''), ('action', 'program'), ('method', 'program')]:
            with self.subTest(xml_tag=xml_tag, pou_type=pou_type):
                self.code.xml_tag, self.code.pou_type = xml_tag, pou_type
                result = self.invoke('create_st', self.action_args(self.code, '/PLC_PRG'))
                self.assertEqual(result['error']['code'], 'INVALID_PARENT')
                self.assertFalse(result['error']['partial'])
                self.assertEqual(self.code.action_creations, 0)
        result = self.invoke('create_st', self.action_args(self.project, '/'))
        self.assertEqual(result['error']['code'], 'INVALID_PARENT')
        self.assertEqual(self.project.action_creations, 0)

    def test_action_create_respects_parent_conflict_and_duplicate_name(self):
        args = self.action_args(self.code, '/PLC_PRG')
        args['expectedChildrenSha256'] = '0' * 64
        self.assertEqual(self.invoke('create_st', args)['error']['code'], 'CONFLICT')
        self.assertEqual(self.code.action_creations, 0)
        self.code.children.append(Object('act_init', implementation=''))
        args = self.action_args(self.code, '/PLC_PRG')
        self.assertEqual(self.invoke('create_st', args)['error']['code'], 'ALREADY_EXISTS')
        self.assertEqual(self.code.action_creations, 0)

    def test_existing_action_replace_changes_only_implementation_and_rejects_non_st(self):
        action = self.code.create_action(name='ACT_Init', language='ST')
        path = '/PLC_PRG/ACT_Init'
        before = self.invoke('read', {'path': path})['result']
        args = {'path': path, 'expectedSha256': before['sha256'], 'declaration': '', 'implementation': 'x := 3;\n'}
        response = self.invoke('replace_st', args)
        self.assertTrue(response['ok'])
        self.assertEqual(action.textual_declaration.writes, 0)
        self.assertEqual(response['result']['readback']['implementation'], args['implementation'])
        args['expectedSha256'] = response['result']['readback']['sha256']
        args['declaration'] = 'VAR x : INT; END_VAR'
        self.assertEqual(self.invoke('replace_st', args)['error']['code'], 'NOT_TEXTUAL')
        args['declaration'] = ''
        action.language = 'IL'
        self.assertEqual(self.invoke('replace_st', args)['error']['code'], 'UNSUPPORTED_LANGUAGE')
        self.assertEqual(action.textual_implementation.writes, 1)

    def test_nested_escaped_paths_and_ambiguous_names(self):
        parent = Object('folder/name~1')
        parent.children.append(Object('P', 'PROGRAM P', ''))
        self.project.children.append(parent)
        listing = self.invoke('list')['result']
        self.assertIn('/folder~1name~01/P', [obj['path'] for obj in listing['objects']])
        self.assertTrue(self.invoke('read', {'path': '/folder~1name~01/P'})['ok'])
        self.project.children.append(Object('PLC_PRG', 'PROGRAM PLC_PRG', ''))
        self.assertEqual(self.invoke('read', {'path': '/PLC_PRG'})['error']['code'], 'OBJECT_NOT_UNIQUE')
        listing = self.invoke('list')['result']['objects']
        duplicate_paths = [item['path'] for item in listing if item['name'] == 'PLC_PRG']
        self.assertEqual(len(duplicate_paths), 2)
        self.assertTrue(all(path.startswith('/PLC_PRG~2') for path in duplicate_paths))
        self.assertTrue(all(self.invoke('read', {'path': path})['ok'] for path in duplicate_paths))

    def test_duplicate_folder_and_action_have_stable_guid_paths(self):
        folder, action = Object('Motion'), Object('Motion', '', 'x := 5;')
        folder.children.append(Object('Run', 'METHOD Run', 'x := 6;'))
        self.project.children.extend([folder, action])
        listing = self.invoke('list')['result']['objects']
        expected = {'/PLC_PRG', '/Motion~2' + folder.guid, '/Motion~2' + action.guid,
                    '/Motion~2' + folder.guid + '/Run'}
        self.assertEqual(set(item['path'] for item in listing), expected)
        self.assertEqual(self.invoke('read', {'path': '/Motion~2' + action.guid})['result']['id'], action.guid)
        self.assertEqual(self.invoke('read', {'path': '/Motion~2' + folder.guid + '/Run'})['result']['implementation'], 'x := 6;')
        self.project.children.reverse()
        self.assertEqual(set(item['path'] for item in self.invoke('list')['result']['objects']), expected)
        self.assertEqual(self.invoke('read', {'path': '/Motion'})['error']['code'], 'OBJECT_NOT_UNIQUE')

    def test_selector_requires_matching_name_and_guid(self):
        duplicate = Object('PLC_PRG', 'PROGRAM PLC_PRG', 'x := 9;')
        duplicate.guid = duplicate.guid.upper()
        self.project.children.append(duplicate)
        qualified = '/PLC_PRG~2' + duplicate.guid.lower()
        readback = self.invoke('read', {'path': qualified})['result']
        self.assertEqual(readback['id'], duplicate.guid)
        self.assertEqual(readback['implementation'], 'x := 9;')
        for path in ('/WrongName~2' + duplicate.guid, '/PLC_PRG~2' + str(uuid.uuid4())):
            self.assertEqual(self.invoke('read', {'path': path})['error']['code'], 'OBJECT_NOT_UNIQUE')
        self.project.children.remove(self.code)
        # A previously qualified selector stays valid after its duplicate is removed.
        self.assertTrue(self.invoke('read', {'path': qualified})['ok'])
        self.assertEqual(self.invoke('list')['result']['objects'][0]['path'], '/PLC_PRG')

    def test_literal_selector_text_in_name_does_not_collide(self):
        first = Object('Motion', '', 'first')
        second = Object('Motion', '', 'second')
        literal = Object('Motion~2' + first.guid, '', 'literal')
        self.project.children.extend([first, second, literal])
        paths = [item['path'] for item in self.invoke('list')['result']['objects']]
        self.assertIn('/Motion~2' + first.guid, paths)
        self.assertIn('/Motion~02' + first.guid, paths)
        self.assertEqual(self.invoke('read', {'path': '/Motion~2' + first.guid})['result']['implementation'], 'first')
        self.assertEqual(self.invoke('read', {'path': '/Motion~02' + first.guid})['result']['implementation'], 'literal')

    def test_nested_duplicate_names_and_escaped_segments_resolve(self):
        parents = [Object('folder/name~1'), Object('folder/name~1')]
        children = [Object('a/b~c', '', 'one'), Object('a/b~c', '', 'two')]
        parents[0].children.extend(children)
        self.project.children.extend(parents)
        listing = self.invoke('list')['result']['objects']
        parent_path = '/folder~1name~01~2' + parents[0].guid
        for child in children:
            path = parent_path + '/a~1b~0c~2' + child.guid
            entry = next(item for item in listing if item['path'] == path)
            self.assertEqual(entry['parentPath'], parent_path)
            self.assertEqual(self.invoke('read', {'path': path})['result']['id'], child.guid)

    def test_selected_write_changes_only_selected_duplicate(self):
        second = Object('PLC_PRG', 'PROGRAM PLC_PRG', 'second')
        self.project.children.append(second)
        path = '/PLC_PRG~2' + second.guid
        before = self.invoke('read', {'path': path})['result']
        response = self.invoke('replace_st', {'path': path, 'expectedSha256': before['sha256'],
                                            'declaration': before['declaration'], 'implementation': 'selected'})
        self.assertTrue(response['ok'])
        self.assertEqual(second.textual_implementation.text, 'selected')
        self.assertEqual(self.code.textual_implementation.text, 'x := 1;\n')

    def test_same_sibling_name_and_guid_remains_ambiguous(self):
        duplicate = Object('PLC_PRG', 'PROGRAM PLC_PRG', '')
        duplicate.guid = self.code.guid.upper()
        self.project.children.append(duplicate)
        response = self.invoke('list')
        self.assertEqual(response['error']['code'], 'AMBIGUOUS_TREE')
        self.assertEqual(response['error']['details']['parentPath'], '/')
        self.assertNotIn('precedingObjects', response['error']['details'])
        path = '/PLC_PRG~2' + self.code.guid
        self.assertEqual(self.invoke('read', {'path': path})['error']['code'], 'OBJECT_NOT_UNIQUE')

    def test_global_guid_reuse_does_not_prune_distinct_branches(self):
        parents = [Object('Left'), Object('Right')]
        children = [Object('Shared', '', 'left'), Object('Shared', '', 'right')]
        children[1].guid = children[0].guid
        for parent, child in zip(parents, children):
            parent.children.append(child)
        self.project.children.extend(parents)
        listing = self.invoke('list')['result']['objects']
        matching = [item for item in listing if item['id'] == children[0].guid]
        self.assertEqual({item['path'] for item in matching}, {'/Left/Shared', '/Right/Shared'})
        self.assertEqual(self.invoke('read', {'path': '/Left/Shared'})['result']['implementation'], 'left')
        self.assertEqual(self.invoke('read', {'path': '/Right/Shared'})['result']['implementation'], 'right')

    def test_malformed_selectors_are_rejected_before_lookup(self):
        for part in ('PLC_PRG~2', 'PLC_PRG~2abcd', 'PLC_PRG~2' + self.code.guid + 'x',
                     'PLC_PRG~2' + self.code.guid + '~2' + self.code.guid, 'PLC_PRG~3x',
                     '~2' + self.code.guid):
            self.assertEqual(self.invoke('read', {'path': '/' + part})['error']['code'], 'INVALID_PATH')

    def test_tree_cycle_hits_depth_guard_without_global_guid_pruning(self):
        loop = Object('Loop')
        loop.children.append(loop)
        self.project.children.append(loop)
        self.assertEqual(self.invoke('list')['error']['code'], 'TREE_TOO_DEEP')
        self.assertEqual(self.invoke('read', {'path': '/' + '/'.join(['Loop'] * 129)})['error']['code'], 'PATH_TOO_DEEP')

    def test_tree_and_lookup_enforce_node_limit(self):
        self.project.children = [Object('Object' + str(i)) for i in range(20001)]
        self.assertEqual(self.invoke('list')['error']['code'], 'TREE_TOO_LARGE')
        self.assertEqual(self.invoke('read', {'path': '/Object0'})['error']['code'], 'TREE_TOO_LARGE')

    def test_no_arbitrary_python_or_online_actions(self):
        for action in ('exec', 'execute_script', 'download', 'start_plc', 'save', 'open'):
            self.assertEqual(self.invoke(action)['error']['code'], 'INVALID_REQUEST')

    def test_invalid_implementation_does_not_write(self):
        before = self.invoke('read', {'path': '/PLC_PRG'})['result']
        result = self.invoke('replace_st', {'path': '/PLC_PRG', 'expectedSha256': before['sha256'],
                                          'declaration': before['declaration'], 'implementation': 0})
        self.assertFalse(result['ok'])
        self.assertEqual(self.code.textual_declaration.writes, 0)

    def test_language_detects_il_and_blocks_st_replacement(self):
        self.code.language = 'IL'
        before = self.invoke('read', {'path': '/PLC_PRG'})['result']
        self.assertEqual(before['language'], 'IL')
        self.assertTrue(before['complete'])
        self.assertFalse(before['sourceComplete'])
        result = self.invoke('replace_st', {'path': '/PLC_PRG', 'expectedSha256': before['sha256'],
                                          'declaration': before['declaration'], 'implementation': 'x:=2;'})
        self.assertEqual(result['error']['code'], 'UNSUPPORTED_LANGUAGE')
        self.assertEqual(self.code.textual_declaration.writes, 0)

    def test_graphical_body_and_export_failure_are_not_complete_st(self):
        self.code.language = 'LD'
        self.code.has_textual_implementation = False
        self.code.export_xml = lambda **kwargs: '<project><pou name="PLC_PRG"><body><LD/></body></pou></project>'
        result = self.invoke('read', {'path': '/PLC_PRG'})['result']
        self.assertEqual(result['language'], 'LD')
        self.assertFalse(result['sourceComplete'])
        def failed_export(**kwargs):
            raise RuntimeError('unsupported export')
        self.code.export_xml = failed_export
        result = self.invoke('read', {'path': '/PLC_PRG'})['result']
        self.assertEqual(result['language'], 'unknown')
        self.assertFalse(result['sourceComplete'])

    def test_language_uses_direct_body_not_nested_method_body(self):
        self.code.export_xml = lambda **kwargs: '<project><pou name="PLC_PRG"><addData><Method name="Run"><body><ST/></body></Method></addData><body><FBD/></body></pou></project>'
        result = self.invoke('read', {'path': '/PLC_PRG'})['result']
        self.assertEqual(result['language'], 'FBD')
        self.assertFalse(result['sourceComplete'])

    def test_compile_requires_explicit_full_build_and_application(self):
        for full_build in (None, False, 1):
            args = {'applicationPath': '/PLC_PRG'}
            if full_build is not None:
                args['fullBuild'] = full_build
            self.assertEqual(self.invoke('compile', args)['error']['code'], 'INVALID_REQUEST')
        result = self.invoke('compile', {'applicationPath': '/PLC_PRG', 'fullBuild': True})
        self.assertEqual(result['error']['code'], 'INVALID_APPLICATION')

    def compile_fixture(self, severity=None, fail=False):
        app = Object('Application')
        app.is_application = True
        self.project.children.append(app)
        message = lambda kind: SimpleNamespace(severity=kind, text='diagnostic', number=7,
                                               prefix='C', position_text='3 (Decl)', object=self.code)
        store = {'old': [message('Error')], 'compile': []}
        cleared = []
        def clear(category):
            cleared.append(category)
            store[category] = []
        def rebuild():
            self.assertEqual(store['old'], [])
            if severity:
                store['compile'] = [message(severity)]
            if fail:
                raise RuntimeError('compiler unavailable')
        app.rebuild = rebuild
        self.engine.system = SimpleNamespace(
            get_message_categories=lambda: list(store), clear_messages=clear,
            get_message_category_description=lambda category: category,
            get_message_objects=lambda category: store[category])
        return cleared

    def test_compile_ignores_cleared_stale_error_and_reports_success(self):
        cleared = self.compile_fixture()
        response = self.invoke('compile', {'applicationPath': '/Application', 'fullBuild': True})
        self.assertTrue(response['ok'])
        result = response['result']
        self.assertTrue(result['success'])
        self.assertEqual(result['errorCount'], 0)
        self.assertTrue(result['fullBuild'])
        self.assertFalse(result['saved'])
        self.assertEqual(set(cleared), {'old', 'compile'})

    def test_compile_normal_return_with_errors_is_not_success(self):
        self.compile_fixture(severity='Error')
        response = self.invoke('compile', {'applicationPath': '/Application', 'fullBuild': True})
        self.assertTrue(response['ok'])
        result = response['result']
        self.assertTrue(result['rebuildReturned'])
        self.assertFalse(result['success'])
        self.assertEqual(result['errorCount'], 1)
        self.assertEqual(result['diagnostics'][0]['object'], 'PLC_PRG')
        self.assertEqual(result['diagnostics'][0]['severity'], 'error')
        self.assertEqual(result['diagnostics'][0]['message'], 'diagnostic')
        self.assertEqual(result['diagnostics'][0]['originalSeverity'], 'Error')

    def test_compile_exception_retains_diagnostics_without_success(self):
        self.compile_fixture(severity='Warning', fail=True)
        response = self.invoke('compile', {'applicationPath': '/Application', 'fullBuild': True})
        self.assertTrue(response['ok'])
        result = response['result']
        self.assertFalse(result['rebuildReturned'])
        self.assertFalse(result['success'])
        self.assertEqual(result['warningCount'], 1)
        self.assertEqual(result['exception'], 'compiler unavailable')


if __name__ == '__main__':
    unittest.main(verbosity=2)
