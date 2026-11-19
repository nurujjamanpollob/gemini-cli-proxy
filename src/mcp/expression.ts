/**
 * Sandboxed arithmetic evaluator used by the built-in `calculate` MCP tool.
 * Tokenises then evaluates a small expression grammar directly — no `eval`,
 * no `Function`, no host access.
 */

type NumberUnary = (value: number) => number;
type NumberBinary = (left: number, right: number) => number;

const UNARY_FUNCTIONS: Record<string, NumberUnary> = {
    abs: Math.abs,
    sqrt: Math.sqrt,
    cbrt: Math.cbrt,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    exp: Math.exp,
    log: Math.log,
    ln: Math.log,
    log10: Math.log10,
    log2: Math.log2,
};

const BINARY_FUNCTIONS: Record<string, NumberBinary> = {
    pow: Math.pow,
    min: Math.min,
    max: Math.max,
    atan2: Math.atan2,
};

const CONSTANTS: Record<string, number> = {
    pi: Math.PI,
    e: Math.E,
    tau: Math.PI * 2,
};

/** Maximum nesting depth accepted before the expression is rejected. */
const MAX_DEPTH = 48;

export class ExpressionError extends Error {}

type Token =
    | {kind: "number"; value: number}
    | {kind: "name"; value: string}
    | {kind: "op"; value: string}
    | {kind: "lparen"}
    | {kind: "rparen"}
    | {kind: "comma"};

const OPERATORS = "+-*/%^";

function tokenize(input: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;

    while (index < input.length) {
        const char = input[index];

        if (/\s/.test(char)) {
            index++;
            continue;
        }

        if (/[0-9.]/.test(char)) {
            const match = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(input.slice(index));
            if (!match) {
                throw new ExpressionError(`malformed number at position ${index}`);
            }
            tokens.push({kind: "number", value: Number(match[0])});
            index += match[0].length;
            continue;
        }

        if (/[a-zA-Z_]/.test(char)) {
            const match = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(input.slice(index));
            if (!match) {
                throw new ExpressionError(`unexpected identifier at position ${index}`);
            }
            tokens.push({kind: "name", value: match[0].toLowerCase()});
            index += match[0].length;
            continue;
        }

        if (char === "(") {
            tokens.push({kind: "lparen"});
            index++;
            continue;
        }
        if (char === ")") {
            tokens.push({kind: "rparen"});
            index++;
            continue;
        }
        if (char === ",") {
            tokens.push({kind: "comma"});
            index++;
            continue;
        }
        if (OPERATORS.includes(char)) {
            tokens.push({kind: "op", value: char});
            index++;
            continue;
        }

        throw new ExpressionError(`unsupported character "${char}" at position ${index}`);
    }

    return tokens;
}

/** Recursive-descent evaluator over the token stream. */
class Evaluator {
    private position = 0;

    constructor(private readonly tokens: Token[]) {}

    evaluate(): number {
        const value = this.parseExpression(0);
        if (this.position < this.tokens.length) {
            throw new ExpressionError("unexpected trailing input");
        }
        return value;
    }

    private peek(): Token | undefined {
        return this.tokens[this.position];
    }

    private parseExpression(depth: number): number {
        let left = this.parseTerm(depth);

        for (;;) {
            const token = this.peek();
            if (!token || token.kind !== "op" || (token.value !== "+" && token.value !== "-")) {
                return left;
            }
            this.position++;
            const right = this.parseTerm(depth);
            left = token.value === "+" ? left + right : left - right;
        }
    }

    private parseTerm(depth: number): number {
        let left = this.parsePower(depth);

        for (;;) {
            const token = this.peek();
            if (!token || token.kind !== "op" || !["*", "/", "%"].includes(token.value)) {
                return left;
            }
            this.position++;
            const right = this.parsePower(depth);
            if (token.value === "*") {
                left *= right;
            } else if (token.value === "/") {
                left /= right;
            } else {
                left %= right;
            }
        }
    }

    private parsePower(depth: number): number {
        const base = this.parseUnary(depth);
        const token = this.peek();

        if (token && token.kind === "op" && token.value === "^") {
            this.position++;
            const exponent = this.parsePower(depth + 1);
            return Math.pow(base, exponent);
        }

        return base;
    }

    private parseUnary(depth: number): number {
        const token = this.peek();

        if (token && token.kind === "op" && (token.value === "-" || token.value === "+")) {
            this.position++;
            const value = this.parseUnary(depth + 1);
            return token.value === "-" ? -value : value;
        }

        return this.parseAtom(depth);
    }

    private parseAtom(depth: number): number {
        if (depth > MAX_DEPTH) {
            throw new ExpressionError("expression nested too deeply");
        }

        const token = this.peek();
        if (!token) {
            throw new ExpressionError("unexpected end of expression");
        }

        if (token.kind === "number") {
            this.position++;
            return token.value;
        }

        if (token.kind === "lparen") {
            this.position++;
            const value = this.parseExpression(depth + 1);
            const closing = this.peek();
            if (!closing || closing.kind !== "rparen") {
                throw new ExpressionError("missing closing parenthesis");
            }
            this.position++;
            return value;
        }

        if (token.kind === "name") {
            this.position++;

            const next = this.peek();
            if (next && next.kind === "lparen") {
                return this.parseCall(token.value, depth);
            }

            const constant = CONSTANTS[token.value];
            if (constant !== undefined) {
                return constant;
            }
            throw new ExpressionError(`unknown constant "${token.value}"`);
        }

        throw new ExpressionError("unexpected token in expression");
    }

    private parseCall(name: string, depth: number): number {
        this.position++; // consume "("

        const args: number[] = [];
        if (this.peek()?.kind !== "rparen") {
            for (;;) {
                args.push(this.parseExpression(depth + 1));
                const separator = this.peek();
                if (separator && separator.kind === "comma") {
                    this.position++;
                    continue;
                }
                break;
            }
        }

        const closing = this.peek();
        if (!closing || closing.kind !== "rparen") {
            throw new ExpressionError(`missing ")" after ${name}(...)`);
        }
        this.position++;

        const unary = UNARY_FUNCTIONS[name];
        if (unary && args.length === 1) {
            return unary(args[0]);
        }

        const binary = BINARY_FUNCTIONS[name];
        if (binary && args.length === 2) {
            return binary(args[0], args[1]);
        }

        throw new ExpressionError(`unsupported call "${name}" with ${args.length} argument(s)`);
    }
}

/** Evaluates an arithmetic expression, throwing `ExpressionError` on bad input. */
export function evaluateExpression(expression: string): number {
    const trimmed = expression.trim();
    if (!trimmed) {
        throw new ExpressionError("expression is empty");
    }
    if (trimmed.length > 512) {
        throw new ExpressionError("expression too long (max 512 characters)");
    }

    const value = new Evaluator(tokenize(trimmed)).evaluate();
    if (!Number.isFinite(value)) {
        throw new ExpressionError("result is not finite");
    }
    return value;
}
