enum Expect {
  Value,
  ObjectKeyOrEnd,
  ObjectKey,
  Colon,
  ObjectCommaOrEnd,
  ArrayValueOrEnd,
  ArrayCommaOrEnd,
}

enum Token {
  Complete,
  Incomplete,
  Invalid,
}

class JsonPrefix {
  private offset = 0
  private readonly stack: Expect[] = [Expect.Value]

  constructor(private readonly source: string) {}

  private escape(): Token {
    const escape = this.source[this.offset++]
    if (escape === undefined) return Token.Incomplete
    if (escape !== "u") return "\"\\/bfnrt".includes(escape) ? Token.Complete : Token.Invalid
    for (let digit = 0; digit < 4; digit += 1) {
      const hexadecimal = this.source[this.offset++]
      if (hexadecimal === undefined) return Token.Incomplete
      if (!/[0-9a-fA-F]/u.test(hexadecimal)) return Token.Invalid
    }
    return Token.Complete
  }

  private string(): Token {
    this.offset += 1
    while (this.offset < this.source.length) {
      const character = this.source[this.offset++]
      if (character === "\"") return Token.Complete
      if (character !== undefined && character < " ") return Token.Invalid
      if (character !== "\\") continue
      const escaped = this.escape()
      if (escaped !== Token.Complete) return escaped
    }
    return Token.Incomplete
  }

  private digit(): boolean {
    const character = this.source[this.offset]
    return character !== undefined && character >= "0" && character <= "9"
  }

  private digits(): Token {
    if (this.offset === this.source.length) return Token.Incomplete
    if (!this.digit()) return Token.Invalid
    while (this.digit()) this.offset += 1
    return Token.Complete
  }

  private number(): Token {
    if (this.source[this.offset] === "-") this.offset += 1
    if (this.source[this.offset] === "0") {
      this.offset += 1
    } else {
      const integer = this.digits()
      if (integer !== Token.Complete) return integer
    }
    if (this.source[this.offset] === ".") {
      this.offset += 1
      const fraction = this.digits()
      if (fraction !== Token.Complete) return fraction
    }
    if (this.source[this.offset] === "e" || this.source[this.offset] === "E") {
      this.offset += 1
      if (this.source[this.offset] === "+" || this.source[this.offset] === "-") this.offset += 1
      return this.digits()
    }
    return Token.Complete
  }

  private literal(value: string): Token {
    for (const expected of value) {
      const character = this.source[this.offset++]
      if (character === undefined) return Token.Incomplete
      if (character !== expected) return Token.Invalid
    }
    return Token.Complete
  }

  private value(): Token {
    const character = this.source[this.offset]
    this.stack.pop()
    if (character === "{" || character === "[") {
      this.offset += 1
      this.stack.push(character === "{" ? Expect.ObjectKeyOrEnd : Expect.ArrayValueOrEnd)
      return Token.Complete
    }
    if (character === "\"") return this.string()
    if (character === "t") return this.literal("true")
    if (character === "f") return this.literal("false")
    if (character === "n") return this.literal("null")
    if (character === "-" || this.digit()) return this.number()
    return Token.Invalid
  }

  private close(): Token {
    this.stack.pop()
    this.offset += 1
    return Token.Complete
  }

  private key(): Token {
    if (this.source[this.offset] !== "\"") return Token.Invalid
    const token = this.string()
    if (token === Token.Complete) this.stack[this.stack.length - 1] = Expect.Colon
    return token
  }

  private colon(): Token {
    if (this.source[this.offset] !== ":") return Token.Invalid
    this.offset += 1
    this.stack[this.stack.length - 1] = Expect.ObjectCommaOrEnd
    this.stack.push(Expect.Value)
    return Token.Complete
  }

  private delimiter(end: string, next: Expect): Token {
    const character = this.source[this.offset]
    if (character === end) return this.close()
    if (character !== ",") return Token.Invalid
    this.offset += 1
    if (next === Expect.ObjectKey) this.stack[this.stack.length - 1] = next
    else this.stack.push(next)
    return Token.Complete
  }

  private next(expected: Expect): Token {
    switch (expected) {
      case Expect.Value: return this.value()
      case Expect.ObjectKeyOrEnd:
        return this.source[this.offset] === "}" ? this.close() : this.key()
      case Expect.ObjectKey: return this.key()
      case Expect.Colon: return this.colon()
      case Expect.ObjectCommaOrEnd: return this.delimiter("}", Expect.ObjectKey)
      case Expect.ArrayCommaOrEnd: return this.delimiter("]", Expect.Value)
      case Expect.ArrayValueOrEnd:
        if (this.source[this.offset] === "]") return this.close()
        this.stack[this.stack.length - 1] = Expect.ArrayCommaOrEnd
        this.stack.push(Expect.Value)
        return Token.Complete
    }
  }

  incomplete(): boolean {
    while (true) {
      while (this.offset < this.source.length && /[ \t\r\n]/u.test(this.source[this.offset] ?? "")) this.offset += 1
      if (this.offset === this.source.length) return this.stack.length > 0
      const expected = this.stack.at(-1)
      if (expected === undefined) return false
      const token = this.next(expected)
      if (token !== Token.Complete) return token === Token.Incomplete
    }
  }
}

// JSC reports the same parse error for a truncated object and an invalid trailing token.
export const isIncompleteJson = (source: string): boolean => new JsonPrefix(source).incomplete()
