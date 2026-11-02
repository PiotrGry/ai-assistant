/** Project unsupported regex grammars for the model only; MCP retains the authoritative schema. */
export function modelToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(modelToolSchema);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "pattern").map(([key, nested]) => {
    if (["const", "default", "enum", "examples"].includes(key)) return [key, nested];
    if (["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key) && nested !== null && typeof nested === "object" && !Array.isArray(nested)) return [key, Object.fromEntries(Object.entries(nested).map(([name, schema]) => [name, modelToolSchema(schema)]))];
    return [key, modelToolSchema(nested)];
  }));
}
