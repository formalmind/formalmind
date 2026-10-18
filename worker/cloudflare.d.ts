/** The slice of the Workers runtime types this app uses (it does not depend on @cloudflare/workers-types). */
declare module "cloudflare:workers" {
	interface SqlStorageCursor<T> extends Iterable<T> {
		toArray(): T[];
		one(): T;
	}
	interface SqlStorage {
		exec<T = Record<string, string | number | null>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
	}
	interface DurableObjectStorage {
		sql: SqlStorage;
		getAlarm(): Promise<number | null>;
		setAlarm(time: number): Promise<void>;
	}
	interface DurableObjectState {
		storage: DurableObjectStorage;
		blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
	}
	export abstract class DurableObject<Env = unknown> {
		protected ctx: DurableObjectState;
		protected env: Env;
		constructor(ctx: DurableObjectState, env: Env);
	}
}
