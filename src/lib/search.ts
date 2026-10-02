/** A LIKE pattern matching `text` anywhere. `%`, `_` and `\` are taken literally (backslash is Postgres' LIKE escape). */
export const containsPattern = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
