import { jsonSchema, type Schema } from "ai";
import { z } from "zod";

/**
 * A zod schema as the AI SDK's own Schema: zod's JSON Schema for the model, validated by the same zod schema. AI SDK
 * v4 reads zod 3 schemas itself; on zod 4 this goes through `jsonSchema`, which depends on no zod at all.
 */
export function aiSchema<T>(schema: z.ZodType<T>): Schema<T> {
	return jsonSchema<T>(z.toJSONSchema(schema, { target: "draft-7" }) as Parameters<typeof jsonSchema>[0], {
		validate: (value) => {
			const r = schema.safeParse(value);
			return r.success ? { success: true, value: r.data } : { success: false, error: r.error };
		},
	});
}
