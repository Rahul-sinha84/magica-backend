import { describe, expect, it } from "vitest";
import { assertTestDatabase } from "../helpers/guard.js";

describe("assertTestDatabase", () => {
  it.each(["magica_test", "other_test"])("accepts %s", (name) => {
    expect(() => assertTestDatabase(`postgresql://u:p@localhost:5432/${name}`)).not.toThrow();
  });

  it.each(["magica_dev", "magica", "magica_test_backup", "production"])("refuses %s", (name) => {
    expect(() => assertTestDatabase(`postgresql://u:p@localhost:5432/${name}`)).toThrow(/Refusing to touch/);
  });

  it("ignores query parameters when reading the database name", () => {
    expect(() => assertTestDatabase("postgresql://u:p@h/magica_test?sslmode=require")).not.toThrow();
    expect(() => assertTestDatabase("postgresql://u:p@h/magica_dev?options=magica_test")).toThrow();
  });
});
