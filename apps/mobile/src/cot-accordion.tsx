import { ChevronDown } from "lucide-react-native";
import { useState } from "react";
import { type LayoutChangeEvent, Pressable, Text, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { accordionHeight, type CotStep, summarise } from "./cot";
import { springs } from "./motion";
import { colors, s } from "./ui";

/** Height of one collapsed row. Matches the row's own padding and line height. */
const ROW_HEIGHT = 40;

/**
 * The agent's working, shown as it works.
 *
 * Rows collapse to one line and expand to the full detail, and only the newest
 * row is emphasised — an accordion where every row is bold reads as noise, and
 * one where the newest is not reads as stalled.
 */
export function CotAccordion({
  steps,
  title = "Working",
}: {
  steps: readonly CotStep[];
  title?: string;
}) {
  const summary = summarise(steps);
  if (!steps.length)
    return <Text style={s.muted}>Nothing recorded yet. The worker logs each step here.</Text>;
  return (
    <View style={{ gap: 6 }}>
      <View style={[s.between, { gap: 12 }]}>
        <Text style={s.heading}>{title}</Text>
        {!!summary && (
          <Text numberOfLines={1} style={[s.small, { flex: 1, textAlign: "right" }]}>
            {summary}
          </Text>
        )}
      </View>
      {steps.map((step) => (
        <CotRow key={step.id} step={step} />
      ))}
    </View>
  );
}

/** One expandable row. */
function CotRow({ step }: { step: CotStep }) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState(ROW_HEIGHT);
  const height = useSharedValue(ROW_HEIGHT);
  const rotate = useSharedValue(0);

  const animated = useAnimatedStyle(() => ({
    height: height.value,
  }));
  const chevron = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotate.value}deg` }],
  }));

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    // The spring is the streaming one: an accordion driven by anything bouncier
    // makes the list below it jitter as each row settles.
    height.value = withSpring(
      accordionHeight(next, content + ROW_HEIGHT, ROW_HEIGHT),
      springs.streaming,
    );
    rotate.value = withSpring(next ? 180 : 0, springs.snappy);
  };

  return (
    <Animated.View style={[{ overflow: "hidden", backgroundColor: colors.canvas }, animated]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${step.headline}. ${expanded ? "Collapse" : "Expand"} for detail`}
        onPress={toggle}
        style={{
          minHeight: ROW_HEIGHT,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 12,
          paddingVertical: 8,
        }}
      >
        <Text
          style={{
            color: step.tint,
            fontSize: step.current ? 14 : 12,
            width: 16,
            textAlign: "center",
          }}
        >
          {step.icon}
        </Text>
        <Text
          numberOfLines={1}
          style={[
            s.text,
            { flex: 1, fontSize: step.current ? 15 : 14 },
            // The newest row is emphasised; older ones recede so the eye lands
            // on what the agent is doing now.
            !step.current && { color: colors.muted },
            step.needsAttention && { color: colors.danger, fontWeight: "600" },
          ]}
        >
          {step.headline}
        </Text>
        <Animated.View style={chevron}>
          <ChevronDown size={15} color={colors.muted} />
        </Animated.View>
      </Pressable>
      {expanded && (
        <Animated.View
          entering={FadeIn.duration(140)}
          exiting={FadeOut.duration(100)}
          onLayout={(event: LayoutChangeEvent) => setContent(event.nativeEvent.layout.height)}
          style={{ paddingHorizontal: 38, paddingBottom: 12 }}
        >
          {!!step.detail && step.detail !== step.headline && (
            <Text selectable style={s.muted}>
              {step.detail}
            </Text>
          )}
          <Text style={[s.small, { marginTop: 4 }]}>{stampFor(step.at)}</Text>
        </Animated.View>
      )}
    </Animated.View>
  );
}

function stampFor(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}
