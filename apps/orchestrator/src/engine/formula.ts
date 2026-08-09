/**
 * A deliberately tiny arithmetic evaluator for `tactics.reservation` and
 * `savings_formula`.
 *
 * Skill files are data, and data from a skill marketplace must never reach `eval`.
 * This grammar supports numbers, dotted identifiers, `+ - * /`, parentheses, unary
 * minus, and the functions min/max/abs/round. Nothing else parses, by construction.
 *
 *   min(spec.budget_max, bus.best_external - 200)
 *   (max_unit_price - best_final_unit_price) * spec.quantity
 */

type Token =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "(" }
  | { t: ")" }
  | { t: "," };

const FUNCS: Record<string, (args: number[]) => number> = {
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  abs: (a) => Math.abs(a[0]),
  round: (a) => Math.round(a[0]),
};

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j])) j++;
      const lit = src.slice(i, j).replace(/_/g, "");
      const v = Number(lit);
      if (!Number.isFinite(v)) throw new Error(`bad number "${lit}"`);
      out.push({ t: "num", v });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_.]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "(") {
      out.push({ t: "(" });
      i++;
      continue;
    }
    if (c === ")") {
      out.push({ t: ")" });
      i++;
      continue;
    }
    if (c === ",") {
      out.push({ t: "," });
      i++;
      continue;
    }
    throw new Error(`unexpected character "${c}" in formula`);
  }
  return out;
}

export type Vars = Record<string, number | null | undefined>;

class Parser {
  private pos = 0;
  constructor(private toks: Token[], private vars: Vars, private missing: string[]) {}

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }
  private next(): Token | undefined {
    return this.toks[this.pos++];
  }

  parse(): number {
    const v = this.expr();
    if (this.pos !== this.toks.length) throw new Error("trailing tokens in formula");
    return v;
  }

  private expr(): number {
    let left = this.term();
    for (;;) {
      const tk = this.peek();
      if (tk?.t === "op" && (tk.v === "+" || tk.v === "-")) {
        this.next();
        const right = this.term();
        left = tk.v === "+" ? left + right : left - right;
      } else return left;
    }
  }

  private term(): number {
    let left = this.unary();
    for (;;) {
      const tk = this.peek();
      if (tk?.t === "op" && (tk.v === "*" || tk.v === "/")) {
        this.next();
        const right = this.unary();
        if (tk.v === "/" && right === 0) throw new Error("division by zero in formula");
        left = tk.v === "*" ? left * right : left / right;
      } else return left;
    }
  }

  private unary(): number {
    const tk = this.peek();
    if (tk?.t === "op" && tk.v === "-") {
      this.next();
      return -this.unary();
    }
    return this.atom();
  }

  private atom(): number {
    const tk = this.next();
    if (!tk) throw new Error("unexpected end of formula");
    if (tk.t === "num") return tk.v;
    if (tk.t === "(") {
      const v = this.expr();
      if (this.next()?.t !== ")") throw new Error("missing )");
      return v;
    }
    if (tk.t === "id") {
      const fn = FUNCS[tk.v];
      if (fn && this.peek()?.t === "(") {
        this.next();
        const args: number[] = [];
        if (this.peek()?.t !== ")") {
          args.push(this.expr());
          while (this.peek()?.t === ",") {
            this.next();
            args.push(this.expr());
          }
        }
        if (this.next()?.t !== ")") throw new Error(`missing ) after ${tk.v}(`);
        return fn(args);
      }
      const val = this.vars[tk.v];
      if (val === undefined || val === null || !Number.isFinite(val)) {
        this.missing.push(tk.v);
        return NaN;
      }
      return val;
    }
    throw new Error("unexpected token in formula");
  }
}

export type EvalResult = { value: number | null; missing: string[] };

/**
 * Evaluate a skill formula. A formula referencing a variable we do not have yet
 * (no external quotes on the bus, say) returns null rather than a wrong number -
 * the negotiator then falls back to the budget alone.
 */
export function evaluateFormula(formula: string, vars: Vars): EvalResult {
  // Skill files may name their result: "quote_spread := max_quote - best_final_quote"
  const body = formula.includes(":=") ? formula.slice(formula.indexOf(":=") + 2) : formula;
  const missing: string[] = [];
  try {
    const value = new Parser(tokenize(body), vars, missing).parse();
    if (!Number.isFinite(value)) return { value: null, missing };
    return { value, missing };
  } catch {
    return { value: null, missing };
  }
}

/** Every identifier a formula reads, for boot-time linting of skill files. */
export function formulaVars(formula: string): string[] {
  const body = formula.includes(":=") ? formula.slice(formula.indexOf(":=") + 2) : formula;
  try {
    return tokenize(body)
      .filter((t): t is { t: "id"; v: string } => t.t === "id")
      .map((t) => t.v)
      .filter((v) => !(v in FUNCS));
  } catch {
    return [];
  }
}
