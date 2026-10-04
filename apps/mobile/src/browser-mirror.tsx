import { Radio } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Image, type LayoutChangeEvent, Text, View } from "react-native";
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { API_URL } from "./api";
import {
  cursorInView,
  MIRROR_VIEW,
  MirrorClient,
  type MirrorSnapshot,
  toBase64,
} from "./mirror-client";
import { springs } from "./motion";
import { colors, s } from "./ui";

/**
 * A live, low-framerate mirror of the agent's browser.
 *
 * The cursor marker is drawn on a spring rather than snapped to each frame's
 * position. The server reports where the agent last acted, and at 4fps that is
 * a series of jumps; without interpolation the marker teleports and reads as a
 * glitch rather than as a hand moving.
 *
 * The frame is held in component state and encoded here rather than pushed
 * straight into the `Image` source, because React Native's Android `Image`
 * will not repaint for a `data:` URI it considers unchanged — and a mirror that
 * silently freezes on the first frame is worse than no mirror.
 */
export function BrowserMirror({ sessionId }: { sessionId: string }) {
  const url = `${API_URL.replace(/^http/, "ws")}/api/browsers/${sessionId}/mirror`;
  const client = useMemo(
    () => new MirrorClient(url, { socket: (target) => new WebSocket(target) as never }),
    [url],
  );
  const [snapshot, setSnapshot] = useState<MirrorSnapshot>(() => client.getSnapshot());
  const [view, setView] = useState({ width: 0, height: 0 });
  const cursorX = useSharedValue(0);
  const cursorY = useSharedValue(0);

  useEffect(() => {
    const mirror = new MirrorClient(url, {
      socket: (target) => new WebSocket(target) as never,
      onChange: setSnapshot,
    });
    mirror.start();
    return () => mirror.stop();
  }, [url]);

  useEffect(() => {
    if (!snapshot.frame || !view.width) return;
    const placed = cursorInView(snapshot.frame.x, snapshot.frame.y, view);
    cursorX.value = withSpring(placed.x, springs.snappy);
    cursorY.value = withSpring(placed.y, springs.snappy);
  }, [cursorX, cursorY, snapshot.frame, view]);

  const cursor = useAnimatedStyle(() => ({
    transform: [{ translateX: cursorX.value }, { translateY: cursorY.value }],
  }));

  return (
    <View style={{ gap: 10 }}>
      <View
        onLayout={(event: LayoutChangeEvent) =>
          setView({
            width: event.nativeEvent.layout.width,
            height: event.nativeEvent.layout.height,
          })
        }
        style={{
          borderRadius: 18,
          overflow: "hidden",
          backgroundColor: "#EEF1F3",
          aspectRatio: MIRROR_VIEW.width / MIRROR_VIEW.height,
        }}
      >
        {snapshot.frame ? (
          <Animated.View entering={FadeIn.duration(160)} style={{ flex: 1 }}>
            <Image
              source={{ uri: `data:image/jpeg;base64,${toBase64(snapshot.frame.bytes)}` }}
              style={{ width: "100%", height: "100%" }}
              resizeMode="contain"
              accessibilityLabel="Live view of the page the agent is reading"
              fadeDuration={0}
            />
            <Animated.View
              pointerEvents="none"
              style={[
                {
                  position: "absolute",
                  left: -7,
                  top: -7,
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  borderWidth: 2,
                  borderColor: colors.blueDark,
                  backgroundColor: "rgba(20,115,200,0.28)",
                },
                cursor,
              ]}
            />
          </Animated.View>
        ) : (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              padding: 20,
            }}
          >
            <Text style={s.muted}>{waitingFor(snapshot.status)}</Text>
          </View>
        )}
      </View>
      <MirrorStatus snapshot={snapshot} />
    </View>
  );
}

/** What to say while no frame has arrived. Never a blank panel. */
function waitingFor(status: MirrorSnapshot["status"]): string {
  switch (status) {
    case "ended":
      return "This browser session is closed.";
    case "reconnecting":
      return "Reconnecting to the browser…";
    case "error":
      return "The live mirror is unavailable. The agent's work is unaffected.";
    default:
      return "Connecting to the browser…";
  }
}

/** A one-line status under the mirror, including the page it is showing. */
function MirrorStatus({ snapshot }: { snapshot: MirrorSnapshot }) {
  if (snapshot.status === "ended")
    return (
      <Text style={s.small}>
        <Radio size={11} color={colors.muted} /> The mirror stopped when the session ended.
      </Text>
    );
  return (
    <View style={[s.between, { gap: 12 }]}>
      <Text numberOfLines={1} style={[s.small, { flex: 1 }]}>
        {snapshot.title || snapshot.url || "Watching the agent’s browser"}
      </Text>
      {snapshot.dropped > 0 && (
        // Surfaced rather than hidden: a person told only "the browser is on
        // frame 9" could not tell a stalled page from a stalled network.
        <Text style={s.small}>{snapshot.dropped} skipped</Text>
      )}
    </View>
  );
}
