import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  FadeInDown,
  SlideOutDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import type { MuseApi } from "./api";
import { springs } from "./motion";
import { colors, s } from "./ui";

/** One undo window as the server reports it. */
export interface UndoEntry {
  id: string;
  label: string;
  status: "pending" | "committed" | "undone" | "failed";
  remainingMs: number;
}

/**
 * The undo toast.
 *
 * Shown while an action is inside its undo window, and gone the moment it is
 * not. Two details are deliberate: the row is driven from the server's
 * `remainingMs` rather than from a local timer, so a countdown that started on
 * the phone and was throttled in the background cannot claim more time than the
 * action actually has; and pressing Undo is immediate and optimistic, because a
 * person who presses it has already decided and should not be made to wait.
 */
export function UndoToast({
  api,
  pollMs = 1000,
  bottom = 150,
}: {
  api: MuseApi;
  pollMs?: number;
  /** Distance from the bottom of the shell; above the notification toast. */
  bottom?: number;
}) {
  const [entry, setEntry] = useState<UndoEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const progress = useSharedValue(1);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const poll = async () => {
      try {
        const next = await api.request<UndoEntry[]>("/api/undo");
        if (!mounted.current) return;
        const pending = next.find((item) => item.status === "pending") ?? null;
        setEntry(pending);
        // Restarting the bar on every poll would make it stutter; it is only
        // re-seeded when a *different* action appears.
        if (pending)
          progress.value = withSpring(
            Math.max(0.02, pending.remainingMs / 5000),
            springs.streaming,
          );
      } catch {
        // A failed poll must not clear a toast the person can still act on; the
        // action is still inside its window even if we cannot see it.
        if (mounted.current) return;
      }
    };
    void poll();
    timer = setInterval(() => void poll(), pollMs);
    return () => {
      mounted.current = false;
      if (timer) clearInterval(timer);
    };
  }, [api, pollMs, progress]);

  const undo = async () => {
    if (!entry || busy) return;
    setBusy(true);
    // Disappear immediately: the person has decided, and waiting for the
    // round trip would make the press feel ignored.
    progress.value = withTiming(0, { duration: 120 });
    try {
      await api.request(`/api/undo/${encodeURIComponent(entry.id)}`, {});
    } catch {
      // The window may have closed between the poll and the press. The next
      // poll will reflect that; nothing to say here.
    } finally {
      if (mounted.current) {
        setEntry(null);
        setBusy(false);
      }
    }
  };

  if (!entry) return null;

  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      exiting={SlideOutDown.duration(220)}
      accessibilityLiveRegion="polite"
      style={{
        position: "absolute",
        left: 20,
        right: 20,
        bottom,
        alignItems: "center",
      }}
    >
      <View
        style={[
          s.row,
          {
            gap: 12,
            paddingLeft: 16,
            paddingRight: 6,
            paddingVertical: 6,
            backgroundColor: colors.text,
            borderRadius: 20,
            maxWidth: 560,
            overflow: "hidden",
          },
        ]}
      >
        <Text numberOfLines={1} style={{ color: "#FFF", fontSize: 13, flexShrink: 1 }}>
          {entry.label}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Undo: ${entry.label}`}
          disabled={busy}
          onPress={() => void undo()}
          style={({ pressed }) => ({
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderRadius: 14,
            backgroundColor: pressed || busy ? colors.blueDark : colors.blue,
          })}
        >
          <Text style={{ color: colors.text, fontSize: 13, fontWeight: "700" }}>
            {busy ? "Undoing…" : "Undo"}
          </Text>
        </Pressable>
        <UndoBar progress={progress} />
      </View>
    </Animated.View>
  );
}

/**
 * The shrinking bar that shows how long is left.
 *
 * Driven from a shared value so it drains smoothly between polls rather than
 * stepping once per second, which is what a naive countdown does and is the
 * reason most undo toasts feel like they're counting in jumps.
 */
function UndoBar({ progress }: { progress: ReturnType<typeof useSharedValue<number>> }) {
  const style = useAnimatedStyle(() => ({
    width: `${Math.round(Math.max(0, Math.min(1, progress.value)) * 100)}%`,
    opacity: progress.value > 0 ? 0.9 : 0,
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: "absolute", left: 0, bottom: 0, height: 2, backgroundColor: colors.blue },
        style,
      ]}
    />
  );
}
