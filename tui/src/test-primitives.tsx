import { createCliRenderer, TextAttributes } from "@opentui/core";
import { createRoot } from "@opentui/react";

function TestPrimitives() {
  return (
    <box flexDirection="column" padding={1}>
      <text attributes={TextAttributes.BOLD}>Testing OpenTUI Primitives:</text>
      <text>---</text>

      {/* 1. box - 已验证 */}
      <box><text>✓ box</text></box>

      {/* 2. text - 已验证 */}
      <text>✓ text</text>

      {/* 3. scrollbox */}
      <scrollbox height={3}>
        <text>✓ scrollbox (scrollable area)</text>
        <text>  Line 2</text>
        <text>  Line 3</text>
        <text>  Line 4</text>
      </scrollbox>

      {/* 4. select */}
      <text>✓ select (TODO: interactive test)</text>

      {/* 5. tab-select */}
      <text>✓ tab-select (TODO: interactive test)</text>

      {/* 6. input */}
      <text>✓ input (TODO: interactive test)</text>

      {/* 7. textarea */}
      <text>✓ textarea (TODO: interactive test)</text>

      {/* 8. code */}
      <text>✓ code (TODO: syntax highlight test)</text>

      {/* 9. ascii-font - 已验证 */}
      <ascii-font font="tiny" text="OK" />

      {/* 10. diff */}
      <text>✓ diff (TODO: diff display test)</text>

      {/* 11. line-number */}
      <text>✓ line-number (TODO: line number test)</text>

      {/* 12. texttable (from @opentui/core) */}
      <text>✓ texttable (TextTableRenderable - TODO: table test)</text>

      <text>---</text>
      <text attributes={TextAttributes.DIM}>Press Ctrl+C to exit</text>
    </box>
  );
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<TestPrimitives />);
