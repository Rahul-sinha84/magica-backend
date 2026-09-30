// A lone half of an emoji (a UTF-16 surrogate without its partner) is allowed in JSON but is not text: Postgres stores it
// as the replacement character. Doing the same before storing and before comparing keeps what was saved and what was
// sent identical (otherwise a replayed message would look "different" from the one already saved).
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export const wellFormed = (text: string): string => text.replace(LONE_SURROGATE, "�");
