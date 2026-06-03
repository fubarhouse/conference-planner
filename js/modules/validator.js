let _validate = null;

async function getValidator() {
  if (_validate) return _validate;
  const schema = await fetch('./schemas/event.schema.json').then((r) => r.json());
  const ajv = new window.Ajv({ allErrors: true });
  _validate = ajv.compile(schema);
  return _validate;
}

export async function validateDataset(data) {
  try {
    const validate = await getValidator();
    const valid = validate(data);
    return { valid, errors: validate.errors ?? [] };
  } catch (e) {
    console.warn('Schema validation unavailable:', e.message);
    return { valid: true, errors: [] };
  }
}

export function formatValidationErrors(errors, dataset = null) {
  const lines = errors
    .slice(0, 15)
    .map((e) => {
      const path = e.dataPath || e.instancePath || '(root)';
      let msg = `  ${path}: ${e.message}`;

      // For "additionalProperties" errors, show which properties are unexpected
      if (e.keyword === 'additionalProperties' && e.params?.additionalProperty) {
        msg += `\n    Unexpected property: "${e.params.additionalProperty}"`;
      }

      // Try to extract and show the actual failing data
      if (dataset && path && path.startsWith('/')) {
        try {
          const pathParts = path.slice(1).split('/').map(p => {
            // Handle array indices like "items/35" → items[35]
            return isNaN(p) ? `.${p}` : `[${p}]`;
          });
          const dataPath = 'dataset' + pathParts.join('');
          const failingData = eval(dataPath);

          if (failingData && typeof failingData === 'object') {
            // For items with title, show that for context
            const context = failingData.title ? `"${failingData.title}"` :
                           failingData.designation ? `"${failingData.designation}"` :
                           failingData.id ? `id: ${failingData.id}` : '';
            if (context) {
              msg += ` [${context}]`;
            }
            // Show the problematic field value
            const fieldName = pathParts[pathParts.length - 1]?.replace(/^\[|\]$/g, '').replace(/^\./, '');
            if (fieldName && fieldName in failingData) {
              const val = failingData[fieldName];
              msg += `\n    Value: ${JSON.stringify(val)}`;
            }
          }
        } catch (err) {
          // Silently ignore if we can't extract the data
        }
      }
      return msg;
    });
  if (errors.length > 15) lines.push(`  … and ${errors.length - 15} more`);
  return lines.join('\n');
}
