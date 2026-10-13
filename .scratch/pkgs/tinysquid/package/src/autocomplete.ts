import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// pi queries argument completions only once a space follows the command
// name. With exactly "/opencode-go" typed, it instead offers a single
// "complete the command name" entry, and Tab just completes the name and
// closes the popup. Wrap the autocomplete provider so the subcommand list
// is offered the moment the bare command is typed.

/** Create an idempotent installer for the bare-command autocomplete wrapper. */
export function createSubcommandAutocompleteInstaller(
  commandName: string,
  subcommandValues: () => { value: string; description: string }[],
): (ctx: ExtensionContext) => void {
  let installed = false;
  return (ctx: ExtensionContext) => {
    if (installed || ctx.mode !== "tui") return;
    installed = true;
    try {
      ctx.ui.addAutocompleteProvider((current) => {
        // Identity set of the items we produce, so applyCompletion can tell our
        // items apart from the wrapped provider's even when values/descriptions
        // coincide.
        const ourItems = new Set<{
          value: string;
          label: string;
          description?: string;
        }>();
        return {
          triggerCharacters: current.triggerCharacters,
          async getSuggestions(lines, cursorLine, cursorCol, _options) {
            const line = lines[cursorLine] ?? "";
            const beforeCursor = line.slice(0, cursorCol);
            if (beforeCursor === `/${commandName}`) {
              const items = subcommandValues().map((s) => ({
                value: s.value,
                label: s.value,
                description: s.description,
              }));
              for (const item of items) ourItems.add(item);
              return { items, prefix: beforeCursor };
            }
            return current.getSuggestions(
              lines,
              cursorLine,
              cursorCol,
              _options,
            );
          },
          applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
            if (ourItems.has(item)) {
              const currentLine = lines[cursorLine] ?? "";
              const beforePrefix = currentLine.slice(
                0,
                cursorCol - prefix.length,
              );
              const afterCursor = currentLine.slice(cursorCol);
              const replacement = `/${commandName} ${item.value}`;
              const newLines = [...lines];
              newLines[cursorLine] = beforePrefix + replacement + afterCursor;
              return {
                lines: newLines,
                cursorLine,
                cursorCol: beforePrefix.length + replacement.length,
              };
            }
            return current.applyCompletion(
              lines,
              cursorLine,
              cursorCol,
              item,
              prefix,
            );
          },
          shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
            current.shouldTriggerFileCompletion?.(
              lines,
              cursorLine,
              cursorCol,
            ) ?? true,
        };
      });
    } catch (err) {
      installed = false;
      console.error(
        "[opencode-go] could not install subcommand autocomplete:",
        err,
      );
    }
  };
}
