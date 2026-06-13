export interface ParsedArgs {
  flag(name: string): boolean;
  option(name: string): string | null;
  positionals(): string[];
}

interface ParseArgsOptions {
  valueOptions?: string[];
}

export function parseArgs(
  args: string[],
  options: ParseArgsOptions = {},
): ParsedArgs {
  const valueOptions = new Set(options.valueOptions ?? []);
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg.startsWith("--")) {
      const equalsIndex = arg.indexOf("=");

      if (equalsIndex > 0) {
        values.set(arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1));
        continue;
      }

      if (valueOptions.has(arg)) {
        const value = args[index + 1];

        if (value !== undefined) {
          values.set(arg, value);
          index += 1;
        } else {
          values.set(arg, "");
        }
        continue;
      }

      flags.add(arg);
      continue;
    }

    if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }

  return {
    flag(name) {
      return flags.has(name);
    },
    option(name) {
      return values.get(name) ?? null;
    },
    positionals() {
      return [...positionals];
    },
  };
}
