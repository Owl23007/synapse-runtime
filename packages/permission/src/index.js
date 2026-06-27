export class StaticPermissionEngine {
    #policies;
    #fallback;
    constructor(policies, fallback = "deny") {
        this.#policies = policies;
        this.#fallback = fallback;
    }
    async decide(request) {
        const decision = this.#policies[request.action] ?? this.#fallback;
        return {
            action: request.action,
            resource: request.resource,
            decision,
            ...(decision === this.#fallback && this.#policies[request.action] === undefined
                ? { reason: "No explicit policy matched this action." }
                : {})
        };
    }
}
//# sourceMappingURL=index.js.map