import { ArrowUpRight, Check, ChevronRight, type LucideIcon, X } from "lucide-react-native";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MascotSignals } from "./mascot.ts";
import { AnimatedMascot } from "./mascot.tsx";
import { durations, springs } from "./motion.ts";
import {
  interpolateFrame,
  restFrame,
  settledFrame,
  type SharedFrame,
  type Rect as SharedRect,
  startFrame,
} from "./shared-element.ts";
export const colors = {
  canvas: "#FCFCFC",
  card: "#FFFFFF",
  text: "#11191C",
  muted: "#697176",
  line: "#EEEEF0",
  blue: "#C8E7FF",
  blueDark: "#1473C8",
  sky: "#EDF7FD",
  green: "#E3F3E8",
  lavender: "#F0EEFA",
  orange: "#FDF0DF",
  danger: "#AA4A45",
};
export const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  text: { color: colors.text, fontSize: 15, lineHeight: 23 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  small: { color: colors.muted, fontSize: 11, lineHeight: 17 },
  label: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  title: { color: colors.text, fontSize: 23, fontWeight: "600", letterSpacing: -0.7 },
  heading: { color: colors.text, fontSize: 16, fontWeight: "600", letterSpacing: -0.25 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 23,
    borderWidth: 0,
    borderColor: colors.line,
    padding: 20,
  },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: 18 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 19,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 16,
    backgroundColor: "#FFF",
    minHeight: 45,
  },
  field: { gap: 7, marginBottom: 16 },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 17,
    minHeight: 42,
    paddingVertical: 10,
    borderRadius: 24,
  },
  primary: { backgroundColor: colors.blue },
  secondary: { backgroundColor: "#F1F2F3" },
  buttonText: { fontSize: 14, fontWeight: "600" },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    alignSelf: "flex-start",
    backgroundColor: colors.canvas,
  },
  chipText: { fontSize: 10, fontWeight: "600", color: colors.muted },
  iconBox: {
    width: 42,
    height: 42,
    borderRadius: 13,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.sky,
  },
  error: { padding: 16, borderRadius: 14, backgroundColor: "#FBEFED", marginVertical: 10, gap: 4 },
  modalShade: {
    flex: 1,
    backgroundColor: "rgba(35,48,44,0.25)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  sheet: {
    backgroundColor: colors.canvas,
    borderRadius: 26,
    width: "100%",
    maxWidth: 790,
    maxHeight: "94%",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.line,
  },
});
export function Button({
  children,
  onPress,
  icon: Icon,
  primary,
  disabled,
  busy,
  small,
  danger,
  style,
}: {
  children: ReactNode;
  onPress: () => void;
  icon?: LucideIcon;
  primary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  danger?: boolean;
  style?: ViewStyle;
}) {
  const color = danger ? colors.danger : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        primary ? s.primary : s.secondary,
        small && { minHeight: 38, paddingVertical: 7, paddingHorizontal: 13 },
        (disabled || busy) && { opacity: 0.5 },
        pressed && { transform: [{ scale: 0.98 }] },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={color} size="small" />
      ) : Icon ? (
        <Icon size={15} color={color} />
      ) : null}
      <Text style={[s.buttonText, { color }]}>{children}</Text>
    </Pressable>
  );
}
export function IconButton({
  icon: Icon,
  label,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        {
          width: 44,
          height: 44,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 22,
          backgroundColor: pressed ? colors.line : "#FFFFFF",
        },
      ]}
    >
      <Icon size={20} strokeWidth={1.8} color={colors.text} />
    </Pressable>
  );
}
/**
 * A card that reports where it is when it is pressed.
 *
 * This is how the "tapping a `TaskCard` expands it into the Details view"
 * transition is built. Reanimated's own `sharedTransitionTag` was the obvious
 * route and it is deliberately not used: in 4.x it is an experimental feature
 * behind a feature flag, it only works with a native stack navigator (OpenMuse
 * presents sheets in a `Modal`), it is explicitly unsupported on web, and the
 * docs note it does not work through a transparent modal on iOS. Every one of
 * those is this app. So the card publishes its own on-screen rectangle and the
 * sheet animates from exactly that rectangle — see `shared-element.ts`.
 *
 * The callback is optional: a card that is never the source of a transition
 * does not need to measure itself, and measurement forces a layout pass.
 */
export function Card({
  children,
  style,
  onLayoutInWindow,
}: {
  children: ReactNode;
  style?: ViewStyle;
  /** Called with this card's absolute screen rectangle as it is laid out. */
  onLayoutInWindow?: (rect: SharedRect) => void;
}) {
  return (
    <View
      style={[s.card, style]}
      // Only measured when someone is going to use the result. `measureInWindow`
      // is relative to the window, which is what the sheet's transform needs.
      ref={
        onLayoutInWindow
          ? (node) => {
              node?.measureInWindow((x, y, width, height) =>
                onLayoutInWindow({ x, y, width, height }),
              );
            }
          : undefined
      }
    >
      {children}
    </View>
  );
}

/**
 * A box whose height grows to fit text that is still arriving.
 *
 * Tool results stream in token by token, and a box that jumps to each new size
 * makes everything below it jump too — the transcript appears to stutter. The
 * height here is interpolated on a critically damped spring instead, and the
 * inner content is allowed to overflow its box, so text is never clipped while
 * the height catches up.
 */
export function StreamingBox({
  children,
  streaming,
  style,
}: {
  children: ReactNode;
  /** True while content is still arriving. */
  streaming?: boolean;
  style?: ViewStyle;
}) {
  const height = useSharedValue(0);
  const measured = useSharedValue(0);
  const styleFor = useAnimatedStyle(() => ({
    height: height.value > 0 ? height.value : undefined,
  }));
  return (
    <Animated.View
      style={[style, styleFor]}
      onLayout={(event) => {
        // Layout runs on the JS thread, so the height it reports is copied into
        // the shared value and animated on the UI thread from there.
        const next = event.nativeEvent.layout.height;
        if (next > 0 && Math.abs(next - measured.value) > 0.5) {
          measured.value = next;
          height.value = withSpring(next, springs.streaming);
        }
      }}
    >
      <Animated.View
        style={streaming ? { opacity: withTiming(1, { duration: durations.quick }) } : undefined}
      >
        {children}
      </Animated.View>
    </Animated.View>
  );
}

/**
 * OpenMuse's capybara.
 *
 * The original was a static PNG, which meant the one element that could have
 * conveyed "the agent is working" conveyed nothing. It now breathes, leans and
 * blinks, and its posture is derived from what the agent is actually doing — see
 * `mascot.ts` for the state machine and why the precedence is what it is.
 *
 * A caller that knows the agent's state passes `signals`; the figure resolves
 * its own state and labels itself for screen readers.
 */
export function Mascot({
  size = 42,
  variant = "sky",
  signals,
}: {
  size?: number;
  variant?: "sky" | "sand" | "lilac";
  signals?: MascotSignals;
}) {
  return <AnimatedMascot size={size} variant={variant} signals={signals} />;
}
export function Chip({ children, tint }: { children: ReactNode; tint?: string }) {
  return (
    <View style={[s.chip, tint ? { backgroundColor: tint } : null]}>
      <Text style={s.chipText}>{children}</Text>
    </View>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={s.field}>
      <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        accessibilityLabel={label}
        {...props}
        style={[
          s.input,
          props.multiline && { minHeight: 120, textAlignVertical: "top" },
          props.style,
        ]}
      />
    </View>
  );
}
export function Empty({
  icon: Icon,
  title,
  detail,
  children,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <View style={{ alignItems: "center", padding: 40, gap: 13 }}>
      <View style={[s.iconBox, { width: 55, height: 55, borderRadius: 18 }]}>
        <Icon size={24} color={colors.blueDark} />
      </View>
      <Text style={s.heading}>{title}</Text>
      <Text style={[s.muted, { textAlign: "center", maxWidth: 360 }]}>{detail}</Text>
      {children}
    </View>
  );
}
export function ErrorNotice({ error }: { error?: string }) {
  return error ? (
    <View accessibilityRole="alert" style={s.error}>
      <Text style={[s.text, { color: colors.danger }]}>{error}</Text>
    </View>
  ) : null;
}
/**
 * A sheet that becomes the thing that was tapped.
 *
 * When `origin` is supplied the panel starts life at exactly that rectangle and
 * travels to where it belongs on the shared spring; with no origin it fades up
 * from just below its settled position. Both the scrim and the panel are driven
 * from one shared value, so a sheet dismissed early can be reversed mid-flight
 * rather than snapping away — which is what `Modal`'s own `animationType` did,
 * since it is a fixed platform curve with no exit variant.
 */
export function Sheet({
  title,
  subtitle,
  children,
  onClose,
  wide,
  origin,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  /** The on-screen rectangle of the element this sheet is becoming. */
  origin?: SharedRect | null;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const compact = width < 600;
  const progress = useSharedValue(0);
  const panelStyle = useSharedValue<SharedFrame>(restFrame());
  const panelNode = useRef<View | null>(null);
  const window = useMemo(() => ({ x: 0, y: 0, width, height }), [width, height]);

  // Measured on the first frame the sheet is on screen, because until then the
  // panel has no geometry and there is nothing to travel from.
  useEffect(() => {
    let cancelled = false;
    panelNode.current?.measureInWindow((x, y, w, h) => {
      if (cancelled) return;
      const measured: SharedRect = { x, y, width: w, height: h };
      const from = startFrame(origin, measured, window);
      // Seed both shared values so the very first rendered frame is already at
      // the source. Without this the panel paints at full size for one frame and
      // then snaps back to the card, which reads as a flicker.
      progress.value = 0;
      panelStyle.value = from;
      progress.value = withSpring(1, springs.shared);
    });
    return () => {
      cancelled = true;
    };
    // `origin` is read once per mount: re-measuring on every change would restart
    // the animation if the origin object were recreated by a parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, panelStyle, progress, window]);

  const animatedPanel = useAnimatedStyle(() => {
    const frame = interpolateFrame(panelStyle.value, settledFrame(), progress.value);
    return {
      opacity: frame.opacity,
      transform: [
        { translateX: frame.translateX },
        { translateY: frame.translateY },
        { scaleX: frame.scaleX },
        { scaleY: frame.scaleY },
      ],
    };
  });
  const shade = useAnimatedStyle(() => ({ opacity: progress.value }));

  return (
    <Modal transparent visible onRequestClose={onClose}>
      <Animated.View
        style={[s.modalShade, compact && { padding: 0, justifyContent: "flex-end" }, shade]}
      >
        <Animated.View
          ref={panelNode}
          accessibilityViewIsModal
          style={[
            s.sheet,
            wide && { maxWidth: 1050 },
            compact && {
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
              paddingBottom: Math.max(insets.bottom, 12),
              maxHeight: "94%",
            },
            animatedPanel,
          ]}
        >
          {compact && (
            <View
              style={{
                alignSelf: "center",
                width: 34,
                height: 4,
                borderRadius: 3,
                backgroundColor: "#D8DBDE",
                marginTop: 10,
              }}
            />
          )}
          <View
            style={[
              s.between,
              { padding: compact ? 20 : 24, borderBottomWidth: 1, borderBottomColor: colors.line },
            ]}
          >
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={s.title}>{title}</Text>
              {!!subtitle && <Text style={s.muted}>{subtitle}</Text>}
            </View>
            <IconButton icon={X} label="Close details" onPress={onClose} />
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: compact ? 20 : 24 }}
          >
            {children}
          </ScrollView>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}
export function CheckRow({
  label,
  checked,
  onPress,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={[s.row, { gap: 10, paddingVertical: 9 }]}
    >
      <View
        style={{
          width: 19,
          height: 19,
          borderRadius: 5,
          borderWidth: 1,
          borderColor: checked ? colors.text : colors.line,
          backgroundColor: checked ? colors.text : "#FFF",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked && <Check size={13} color="#FFF" />}
      </View>
      <Text style={[s.text, { flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}
export function SectionHeading({
  title,
  action,
  onPress,
}: {
  title: string;
  action?: string;
  onPress?: () => void;
}) {
  return (
    <View style={[s.between, { marginBottom: 19 }]}>
      <Text style={s.heading}>{title}</Text>
      {action && onPress && (
        <Pressable accessibilityRole="button" onPress={onPress} style={[s.row, { gap: 5 }]}>
          <Text style={[s.small, { color: colors.text }]}>{action}</Text>
          <ArrowUpRight size={13} color={colors.muted} />
        </Pressable>
      )}
    </View>
  );
}
export function LinkRow({
  title,
  detail,
  onPress,
  icon: Icon,
  tint,
}: {
  title: string;
  detail?: string;
  onPress: () => void;
  icon: LucideIcon;
  tint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        s.row,
        { paddingVertical: 13, gap: 14, borderRadius: 10 },
        pressed && { backgroundColor: colors.canvas },
      ]}
    >
      <View style={[s.iconBox, { backgroundColor: tint || colors.sky }]}>
        <Icon size={19} color={colors.text} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[s.text, { fontWeight: "500" }]}>{title}</Text>
        {!!detail && <Text style={s.small}>{detail}</Text>}
      </View>
      <ChevronRight size={15} color={colors.muted} />
    </Pressable>
  );
}
export function dateLabel(value: string, options?: Intl.DateTimeFormatOptions) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-US", options || { month: "short", day: "numeric" });
}
export function timeLabel(value: string, timeZone?: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}
export function relativeDate(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  return diff < 60_000
    ? "Just now"
    : diff < 3600_000
      ? `${Math.floor(diff / 60_000)}m ago`
      : diff < 86400_000
        ? `${Math.floor(diff / 3600_000)}h ago`
        : dateLabel(value);
}

export function resultSummary(value: string) {
  return /^Saved to (?:sample|local) sent mail(?: · .+)?$/.test(value)
    ? "Reply saved in your local Sent mail."
    : value;
}
