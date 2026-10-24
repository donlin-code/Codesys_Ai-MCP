import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceClassification } from '../src/capture.js';

test('graphical and unknown textual languages never certify complete ST coverage', () => {
  for (const source of [
    {declaration: 'PROGRAM P\nVAR\nEND_VAR', hasImplementation: false},
    {declaration: 'FUNCTION_BLOCK FB', hasImplementation: true},
    {declaration: 'FUNCTION_BLOCK FB', language: 'IL', sourceComplete: true},
    {declaration: 'METHOD M', language: 'ST', sourceComplete: false},
    {declaration: '(*\nTYPE NotReallyADut\n*)\nPROGRAM P', sourceKind: 'POU', language: 'FBD', sourceComplete: false},
  ]) assert.equal(sourceClassification(source).supported, false);
});
test('DUT/GVL declarations and proven complete ST methods are captured', () => {
  assert.deepEqual(sourceClassification({declaration: "{attribute 'qualified_only'}\nVAR_GLOBAL\nx : BOOL;\nEND_VAR", sourceKind: 'GVL', sourceComplete: true}), {type: 'GVL', language: 'ST', supported: true});
  assert.deepEqual(sourceClassification({declaration: 'TYPE T : STRUCT\nx : BOOL;\nEND_STRUCT\nEND_TYPE', sourceKind: 'DUT', sourceComplete: true}), {type: 'DUT', language: 'ST', supported: true});
  assert.deepEqual(sourceClassification({declaration: 'METHOD M', language: 'ST', sourceComplete: true}), {type: 'METHOD', language: 'ST', supported: true});
});

test('ACTION identity requires source metadata and ST coverage still requires a complete body', () => {
  assert.deepEqual(sourceClassification({declaration: '', sourceKind: 'ACTION', language: 'ST', sourceComplete: true}), {type: 'ACTION', language: 'ST', supported: true});
  assert.deepEqual(sourceClassification({declaration: '', sourceKind: 'unknown', language: 'ST', sourceComplete: true}), {type: 'text', language: 'ST', supported: true});
  assert.deepEqual(sourceClassification({declaration: ''}), {type: 'text', language: 'unknown', supported: false});
  assert.deepEqual(sourceClassification({declaration: '', sourceKind: 'ACTION', language: 'FBD', sourceComplete: false}), {type: 'ACTION', language: 'FBD', supported: false});
  assert.equal(sourceClassification({declaration: '', sourceKind: 'ACTION', language: 'ST', sourceComplete: false}).supported, false);
});
