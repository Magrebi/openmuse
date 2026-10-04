import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { collapseContext, describeDiff, diffText, keyRows } from "./diff.ts";
import { Button, Card, Chip, colors, s } from "./ui.tsx";

/**
 * Edit a proposed message in place, showing what the edit changed.
 *
 * The reason this exists rather than a link to the full editor: the full editor
 * throws the proposal away, so fixing one word costs a deny, a re-draft and a
 * fresh review — and the agent may well come back with the same wording. Editing
 * in place keeps the review as the thing the reviewer is looking at.
 *
 * The diff is the safety mechanism, not a flourish. The reason to be suspicious
 * of an agent's draft is not that it is badly written but that you cannot tell
 * what it kept from what it invented. Seeing the agent's lines struck through
 * beside your own additions answers that in a way a finished draft cannot.
 */
export function DiffEditor({
  label,
  draft,
  onChange,
  multiline = true,
  minHeight = 150,
}: {
  label: string;
  /** What the agent proposed. */
  draft: string;
  onChange: (next: string) => void;
  multiline?: boolean;
  minHeight?: number;
}) {
  const [value, setValue] = useState(draft);
  const [showDiff, setShowDiff] = useState(false);
  // Memoised on the pair rather than computed inline, because this recomputes on
  // every keystroke and the LCS table is the expensive part.
  const diff = useMemo(() => diffText(draft, value), [draft, value]);
  const edited = diff.changed > 0;

  return (
    <View style={{ gap: 9 }}>
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>{label}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={showDiff ? "Hide changes" : "Show changes from the agent's draft"}
          disabled={!edited}
          onPress={() => setShowDiff((open) => !open)}
          style={{ opacity: edited ? 1 : 0.4 }}
        >
          <Chip tint={edited ? colors.blue : colors.line}>
            {edited ? describeDiff(diff) : "Unedited"}
          </Chip>
        </Pressable>
      </View>
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <TextInput
          accessibilityLabel={label}
          multiline={multiline}
          placeholderTextColor={colors.muted}
          value={value}
          onChangeText={(next) => {
            setValue(next);
            onChange(next);
          }}
          style={{
            minHeight,
            padding: 14,
            color: colors.text,
            fontSize: 15,
            lineHeight: 23,
            textAlignVertical: "top",
          }}
        />
        {showDiff && edited && (
          <Animated.View entering={FadeIn.duration(140)} exiting={FadeOut.duration(100)}>
            <DiffRows diff={diff} />
          </Animated.View>
        )}
      </Card>
    </View>
  );
}

/** The diff itself: struck agent lines beside the reviewer's own. */
function DiffRows({ diff }: { diff: ReturnType<typeof diffText> }) {
  const rows = collapseContext(diff.lines, 2);
  const keys = keyRows(rows);
  return (
    <View
      style={{ borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.canvas }}
    >
      <Text style={[s.small, { paddingHorizontal: 14, paddingTop: 12 }]}>
        Against the agent&rsquo;s draft
      </Text>
      <View style={{ paddingVertical: 10 }}>
        {rows.map((row, index) => {
          const key = keys[index];
          return row.kind === "gap" ? (
            <Text
              key={key}
              style={[s.small, { paddingHorizontal: 14, paddingVertical: 3, fontStyle: "italic" }]}
            >
              {row.count} unchanged {row.count === 1 ? "line" : "lines"}
            </Text>
          ) : (
            <Animated.View
              key={key}
              layout={LinearTransition.duration(140)}
              entering={FadeIn.duration(120)}
              style={{
                flexDirection: "row",
                gap: 9,
                paddingHorizontal: 14,
                paddingVertical: 3,
                backgroundColor:
                  row.kind === "added"
                    ? colors.green
                    : row.kind === "removed"
                      ? colors.orange
                      : "transparent",
              }}
            >
              <Text
                style={{
                  width: 12,
                  color: colors.muted,
                  fontSize: 13,
                  fontWeight: "700",
                  lineHeight: 22,
                }}
              >
                {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : ""}
              </Text>
              <Text
                selectable
                style={{
                  flex: 1,
                  color: row.kind === "same" ? colors.muted : colors.text,
                  fontSize: 14,
                  lineHeight: 22,
                  textDecorationLine: row.kind === "removed" ? "line-through" : "none",
                }}
              >
                {row.text || " "}
              </Text>
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
}

/** Confirm the edits, or put the agent's wording back. */
export function DiffActions({
  canSave,
  canRevert,
  busy,
  onSave,
  onRevert,
  saveLabel = "Save changes",
}: {
  canSave: boolean;
  canRevert: boolean;
  busy: boolean;
  onSave: () => void;
  onRevert: () => void;
  saveLabel?: string;
}) {
  if (!canSave && !canRevert) return null;
  return (
    <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
      {canSave && (
        <Button primary busy={busy} onPress={onSave}>
          {saveLabel}
        </Button>
      )}
      {canRevert && (
        <Button disabled={busy} onPress={onRevert}>
          Use the agent&rsquo;s wording
        </Button>
      )}
    </View>
  );
}
