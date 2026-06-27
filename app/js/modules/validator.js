let _validate = null;
let _validatorError = null;

async function getValidator() {
  if (_validate) return _validate;
  if (_validatorError) throw _validatorError;
  try {
    const schema = await fetch('./schemas/event.schema.json').then((r) => r.json());
    const ajv = new globalThis.Ajv({ allErrors: true });
    _validate = ajv.compile(schema);
    return _validate;
  } catch (e) {
    _validatorError = e;
    throw e;
  }
}

export async function validateDataset(data) {
  try {
    const validate = await getValidator();
    const valid = validate(data);
    return { valid, errors: validate.errors ?? [] };
  } catch (e) {
    return {
      valid: false,
      errors: [{ message: `Schema validation unavailable: ${e.message}` }],
    };
  }
}

export function formatValidationErrors(errors, dataset = null) {
  const lines = errors
    .slice(0, 15)
    .map((e) => {
      const path = e.dataPath || e.instancePath || '(root)';
      let msg = `  ${path}: ${e.message}`;

      if (e.keyword === 'additionalProperties' && e.params?.additionalProperty) {
        msg += `\n    Unexpected property: "${e.params.additionalProperty}"`;
      }

      if (dataset && path && path.startsWith('/')) {
        try {
          const parts = path.slice(1).split('/');
          const failingData = parts.reduce((obj, key) => {
            if (obj == null) return undefined;
            return obj[isNaN(key) ? key : Number(key)];
          }, dataset);

          if (failingData && typeof failingData === 'object') {
            const context = failingData.title ? `"${failingData.title}"` :
                           failingData.designation ? `"${failingData.designation}"` :
                           failingData.id ? `id: ${failingData.id}` : '';
            if (context) msg += ` [${context}]`;

            const lastKey = parts[parts.length - 1];
            const parent = parts.slice(0, -1).reduce((obj, key) => {
              if (obj == null) return undefined;
              return obj[isNaN(key) ? key : Number(key)];
            }, dataset);
            if (parent != null && lastKey in Object(parent)) {
              msg += `\n    Value: ${JSON.stringify(parent[isNaN(lastKey) ? lastKey : Number(lastKey)])}`;
            }
          }
        } catch {
          // ignore — best-effort context only
        }
      }
      return msg;
    });
  if (errors.length > 15) lines.push(`  … and ${errors.length - 15} more`);
  return lines.join('\n');
}
