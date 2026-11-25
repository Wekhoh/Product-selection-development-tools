/**
 * Single shared JSON Schema structural check & runtime validator.
 * Replaces duplicate hand-rolled schema walkers in codex-runner.mjs, receipt-verifier.mjs, and client.mjs.
 */
import { canonicalJson, isPlainObject } from './objects.mjs';

export const SUPPORTED_JSON_SCHEMA_KEYWORDS = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'default',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minProperties',
  'maxProperties',
]);

export const CLIENT_EXTRA_JSON_SCHEMA_KEYWORDS = new Set([
  'oneOf',
  'allOf',
  'not',
  'nullable',
  'examples',
  'strict',
]);

export const UNSUPPORTED_JSON_SCHEMA_KEYWORDS = new Set([
  '$ref',
  '$dynamicRef',
  '$recursiveRef',
  '$defs',
  'definitions',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas',
  'dependencies',
  'patternProperties',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
  'prefixItems',
  'contains',
  'minContains',
  'maxContains',
  'additionalItems',
  'format',
]);

function unsupportedSchemaError(message, ErrorClass) {
  const err = new ErrorClass(message);
  err.code = 'UNSUPPORTED_JSON_SCHEMA_KEYWORD';
  return err;
}

function compileSchemaPattern(pattern, path, ErrorClass = TypeError) {
  try {
    return new RegExp(pattern, 'u');
  } catch {
    try {
      return new RegExp(pattern);
    } catch (err) {
      throw new ErrorClass(`${path}.pattern is not a valid regular expression: ${err.message}`);
    }
  }
}

function jsonDeepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return canonicalJson(a) === canonicalJson(b);
}

function matchesJsonSchemaType(value, expectedType) {
  switch (expectedType) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return false;
  }
}

function isKeywordAllowed(key, strictCodexDialect) {
  if (SUPPORTED_JSON_SCHEMA_KEYWORDS.has(key)) return true;
  if (!strictCodexDialect && CLIENT_EXTRA_JSON_SCHEMA_KEYWORDS.has(key)) return true;
  return false;
}

export function assertSupportedStrictJsonSchema(
  schemaNode,
  path = 'codex_schema',
  { ErrorClass = Error, strictCodexDialect = true, maxDepth = 48, depth = 0 } = {},
) {
  if (depth > maxDepth) {
    throw new ErrorClass(`${path} exceeds maximum JSON Schema nesting depth.`);
  }
  if (schemaNode === false) {
    if (!strictCodexDialect) return;
    throw unsupportedSchemaError(`${path} is a boolean false schema that rejects all values.`, ErrorClass);
  }
  if (schemaNode === true) return;
  if (!isPlainObject(schemaNode)) {
    const BadTypeClass = strictCodexDialect ? TypeError : ErrorClass;
    throw new BadTypeClass(`${path} must be a plain JSON Schema object or boolean.`);
  }
  for (const key of Object.keys(schemaNode)) {
    if (!Object.hasOwn(schemaNode, key)) continue;
    if (!isKeywordAllowed(key, strictCodexDialect)) {
      throw unsupportedSchemaError(
        `${path} contains unsupported JSON Schema keyword "${key}"; only strict locally-validated keywords are permitted.`,
        ErrorClass,
      );
    }
  }
  if (schemaNode.pattern !== undefined) {
    const BadPatternClass = strictCodexDialect ? TypeError : ErrorClass;
    if (typeof schemaNode.pattern !== 'string') {
      throw new BadPatternClass(`${path}.pattern must be a regular expression string.`);
    }
    compileSchemaPattern(schemaNode.pattern, path, BadPatternClass);
  }
  const subOpts = { ErrorClass, strictCodexDialect, maxDepth, depth: depth + 1 };
  for (const combKey of ['anyOf', 'oneOf', 'allOf']) {
    if (schemaNode[combKey] !== undefined) {
      const BadCombClass = strictCodexDialect ? TypeError : ErrorClass;
      if (!Array.isArray(schemaNode[combKey]) || schemaNode[combKey].length === 0) {
        throw new BadCombClass(`${path}.${combKey} must be a nonempty array.`);
      }
      schemaNode[combKey].forEach((branch, idx) => {
        assertSupportedStrictJsonSchema(branch, `${path}.${combKey}[${idx}]`, subOpts);
      });
    }
  }
  if (schemaNode.not !== undefined) {
    assertSupportedStrictJsonSchema(schemaNode.not, `${path}.not`, subOpts);
  }
  if (schemaNode.properties !== undefined) {
    const BadPropClass = strictCodexDialect ? TypeError : ErrorClass;
    if (!isPlainObject(schemaNode.properties)) throw new BadPropClass(`${path}.properties must be a plain object.`);
    for (const [propKey, propSubSchema] of Object.entries(schemaNode.properties)) {
      if (propSubSchema !== false || !strictCodexDialect) {
        assertSupportedStrictJsonSchema(propSubSchema, `${path}.properties.${propKey}`, subOpts);
      }
    }
  }
  if (schemaNode.additionalProperties !== undefined && typeof schemaNode.additionalProperties !== 'boolean') {
    assertSupportedStrictJsonSchema(schemaNode.additionalProperties, `${path}.additionalProperties`, subOpts);
  }
  if (schemaNode.items !== undefined && (schemaNode.items !== false || !strictCodexDialect)) {
    if (Array.isArray(schemaNode.items)) {
      throw unsupportedSchemaError(
        `${path}.items tuple array form is unsupported; supply a single items schema object.`,
        ErrorClass,
      );
    }
    assertSupportedStrictJsonSchema(schemaNode.items, `${path}.items`, subOpts);
  }
}

export function validateJsonAgainstStrictSchema(
  value,
  schemaNode,
  path = '$',
  { ErrorClass = Error, strictCodexDialect = true, maxDepth = 48, depth = 0 } = {},
) {
  if (depth > maxDepth) {
    throw new ErrorClass(`${path} exceeds maximum JSON Schema validation depth.`);
  }
  if (schemaNode === false) {
    throw new TypeError(`${path} failed validation: boolean false schema rejects all values.`);
  }
  if (schemaNode === true) return { valid: true };
  if (!isPlainObject(schemaNode)) {
    throw new TypeError(`${path} schema must be a plain JSON Schema object or boolean.`);
  }
  for (const key of Object.keys(schemaNode)) {
    if (!Object.hasOwn(schemaNode, key)) continue;
    if (!isKeywordAllowed(key, strictCodexDialect)) {
      throw unsupportedSchemaError(`${path} schema uses unsupported JSON Schema keyword "${key}".`, ErrorClass);
    }
  }
  if (!strictCodexDialect && schemaNode.nullable === true && value === null) {
    return { valid: true };
  }
  const subOpts = { ErrorClass, strictCodexDialect, maxDepth, depth: depth + 1 };
  if (Array.isArray(schemaNode.allOf)) {
    for (let i = 0; i < schemaNode.allOf.length; i++) {
      validateJsonAgainstStrictSchema(value, schemaNode.allOf[i], `${path}(allOf[${i}])`, subOpts);
    }
  }
  if (Array.isArray(schemaNode.anyOf)) {
    const matched = schemaNode.anyOf.some(branch => {
      try {
        validateJsonAgainstStrictSchema(value, branch, path, subOpts);
        return true;
      } catch {
        return false;
      }
    });
    if (!matched) throw new TypeError(`${path} did not match any allowed anyOf schema branch.`);
  }
  if (Array.isArray(schemaNode.oneOf)) {
    let matches = 0;
    for (const branch of schemaNode.oneOf) {
      try {
        validateJsonAgainstStrictSchema(value, branch, path, subOpts);
        matches += 1;
      } catch {
        // branch did not match
      }
    }
    if (matches !== 1) {
      throw new TypeError(`${path} matched ${matches} oneOf branches (expected 1).`);
    }
  }
  if (schemaNode.not !== undefined) {
    let matchedNot = false;
    try {
      validateJsonAgainstStrictSchema(value, schemaNode.not, path, subOpts);
      matchedNot = true;
    } catch {
      matchedNot = false;
    }
    if (matchedNot) {
      throw new TypeError(`${path} matched forbidden "not" schema.`);
    }
  }
  if (schemaNode.type !== undefined) {
    const allowedTypes = Array.isArray(schemaNode.type) ? schemaNode.type : [schemaNode.type];
    if (!allowedTypes.some(t => matchesJsonSchemaType(value, t))) {
      throw new TypeError(`${path} failed JSON Schema type check (expected ${JSON.stringify(schemaNode.type)}).`);
    }
  }
  if (Array.isArray(schemaNode.enum)) {
    if (!schemaNode.enum.some(allowed => jsonDeepEqual(allowed, value))) {
      throw new TypeError(`${path} value is not permitted by schema enum.`);
    }
  }
  if (Object.hasOwn(schemaNode, 'const') && !jsonDeepEqual(value, schemaNode.const)) {
    throw new TypeError(`${path} value does not match schema const.`);
  }
  if (typeof value === 'string') {
    const strLen = strictCodexDialect ? Array.from(value).length : value.length;
    if (typeof schemaNode.minLength === 'number' && strLen < schemaNode.minLength) {
      throw new TypeError(`${path} string length (${strLen}) is below minLength (${schemaNode.minLength}).`);
    }
    if (typeof schemaNode.maxLength === 'number' && strLen > schemaNode.maxLength) {
      throw new TypeError(`${path} string length (${strLen}) exceeds maxLength (${schemaNode.maxLength}).`);
    }
    if (typeof schemaNode.pattern === 'string') {
      const re = compileSchemaPattern(schemaNode.pattern, path);
      if (!re.test(value)) {
        throw new TypeError(`${path} string value did not match schema pattern /${schemaNode.pattern}/.`);
      }
    }
  }
  if (typeof value === 'number') {
    if (typeof schemaNode.minimum === 'number' && value < schemaNode.minimum) {
      throw new TypeError(`${path} number (${value}) is below minimum (${schemaNode.minimum}).`);
    }
    if (typeof schemaNode.maximum === 'number' && value > schemaNode.maximum) {
      throw new TypeError(`${path} number (${value}) exceeds maximum (${schemaNode.maximum}).`);
    }
    if (typeof schemaNode.exclusiveMinimum === 'number' && value <= schemaNode.exclusiveMinimum) {
      throw new TypeError(`${path} number (${value}) must be > exclusiveMinimum (${schemaNode.exclusiveMinimum}).`);
    }
    if (typeof schemaNode.exclusiveMaximum === 'number' && value >= schemaNode.exclusiveMaximum) {
      throw new TypeError(`${path} number (${value}) must be < exclusiveMaximum (${schemaNode.exclusiveMaximum}).`);
    }
    if (typeof schemaNode.multipleOf === 'number' && schemaNode.multipleOf > 0) {
      const quotient = value / schemaNode.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-12) {
        throw new TypeError(`${path} number (${value}) is not a multipleOf (${schemaNode.multipleOf}).`);
      }
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (!isPlainObject(value)) throw new TypeError(`${path} must be a plain JSON object.`);
    const ownKeys = Object.keys(value);
    if (typeof schemaNode.minProperties === 'number' && ownKeys.length < schemaNode.minProperties) {
      throw new TypeError(`${path} property count (${ownKeys.length}) is below minProperties (${schemaNode.minProperties}).`);
    }
    if (typeof schemaNode.maxProperties === 'number' && ownKeys.length > schemaNode.maxProperties) {
      throw new TypeError(`${path} property count (${ownKeys.length}) exceeds maxProperties (${schemaNode.maxProperties}).`);
    }
    if (Array.isArray(schemaNode.required)) {
      for (const reqKey of schemaNode.required) {
        if (!Object.hasOwn(value, reqKey) || value[reqKey] === undefined) {
          throw new TypeError(`${path} is missing schema-required property "${reqKey}".`);
        }
      }
    }
    const propsSpec = isPlainObject(schemaNode.properties) ? schemaNode.properties : null;
    if (schemaNode.additionalProperties === false) {
      for (const ownKey of ownKeys) {
        if (!propsSpec || !Object.hasOwn(propsSpec, ownKey)) {
          throw new TypeError(`${path} contains undeclared additional property "${ownKey}".`);
        }
      }
    }
    for (const ownKey of ownKeys) {
      const propVal = value[ownKey];
      if (propsSpec && Object.hasOwn(propsSpec, ownKey)) {
        validateJsonAgainstStrictSchema(propVal, propsSpec[ownKey], `${path}.${ownKey}`, subOpts);
      } else if (schemaNode.additionalProperties && typeof schemaNode.additionalProperties === 'object') {
        validateJsonAgainstStrictSchema(propVal, schemaNode.additionalProperties, `${path}.${ownKey}`, subOpts);
      }
    }
  }
  if (Array.isArray(value)) {
    if (typeof schemaNode.minItems === 'number' && value.length < schemaNode.minItems) {
      throw new TypeError(`${path} array length (${value.length}) is below minItems (${schemaNode.minItems}).`);
    }
    if (typeof schemaNode.maxItems === 'number' && value.length > schemaNode.maxItems) {
      throw new TypeError(`${path} array length (${value.length}) exceeds maxItems (${schemaNode.maxItems}).`);
    }
    if (schemaNode.uniqueItems === true) {
      for (let i = 0; i < value.length; i++) {
        for (let j = i + 1; j < value.length; j++) {
          if (jsonDeepEqual(value[i], value[j])) {
            throw new TypeError(`${path} array contains duplicate items at indices ${i} and ${j}.`);
          }
        }
      }
    }
    if (schemaNode.items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        validateJsonAgainstStrictSchema(value[i], schemaNode.items, `${path}[${i}]`, subOpts);
      }
    }
  }
  return { valid: true };
}
