import { useEffect } from "react";
import type { ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Ellipse, G } from "react-native-svg";
import {
  type MascotSignals,
  type MascotState,
  mascotFrame,
  mascotLabel,
  mascotSpring,
  resolveMascotState,
} from "./mascot.ts";
import { durations } from "./motion.ts";

/** OpenMuse's own capybara, drawn rather than bitmapped so that it can breathe. */
function Capybara({
  size,
  eyeOpen,
  pupil,
  fill,
  aura,
  auraScale,
}: {
  size: number;
  eyeOpen: number;
  pupil: number;
  fill: string;
  aura: number;
  auraScale: number;
}) {
  const eyeHeight = Math.max(0.6, size * 0.055 * eyeOpen);
  const eyeWidth = size * 0.075;
  const pupilRadius = size * 0.03 * pupil;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Circle cx={50} cy={50} r={46 * auraScale} fill={fill} opacity={aura * 0.45} />
      <Ellipse cx={50} cy={62} rx={34} ry={30} fill={fill} />
      <Circle cx={50} cy={40} r={26} fill={fill} />
      <Circle cx={31} cy={26} r={7} fill={fill} />
      <Circle cx={69} cy={26} r={7} fill={fill} />
      <Ellipse cx={50} cy={54} rx={17} ry={12} fill="#FFFFFF" opacity={0.5} />
      <Circle cx={50} cy={52} r={1.6 + size * 0.012 * (0.4 + eyeOpen * 0.6)} fill="#3A3128" />
      {/* The eye aperture is what carries the state. */}
      <Ellipse cx={41} cy={37} rx={eyeWidth / 2} ry={eyeHeight / 2} fill="#3A3128" />
      <Ellipse cx={59} cy={37} rx={eyeWidth / 2} ry={eyeHeight / 2} fill="#3A3128" />
      {pupilRadius > 0.4 && (
        <G>
          <Circle cx={41 + size * 0.008} cy={37} r={pupilRadius} fill="#FFFFFF" opacity={0.9} />
          <Circle cx={59 + size * 0.008} cy={37} r={pupilRadius} fill="#FFFFFF" opacity={0.9} />
        </G>
      )}
    </Svg>
  );
}

/**
 * The mascot, animated.
 *
 * Two clocks run here and they are deliberately different. Discrete values —
 * scale, tilt, eye aperture, aura — move on springs, because a state change is
 * an event and events deserve physics. Continuous values — the bob and the lean
 * — are sampled from a sine on the UI thread, because breathing must be able to
 * start and stop mid-cycle without a jump. Interpolating the breathing with a
 * spring instead would make it stutter at each reversal of the sine.
 */
export function AnimatedMascot({
  size = 42,
  variant = "sky",
  state,
  signals,
  style,
}: {
  size?: number;
  variant?: "sky" | "sand" | "lilac";
  /** An explicit state, or pass `signals` to derive one. */
  state?: MascotState;
  signals?: MascotSignals;
  style?: ViewStyle;
}) {
  const resolved = state ?? resolveMascotState(signals);
  const clock = useSharedValue(0);
  const scale = useSharedValue(1);
  const tilt = useSharedValue(0);
  const lean = useSharedValue(0);
  const eyeOpen = useSharedValue(0.85);
  const pupil = useSharedValue(0.5);
  const aura = useSharedValue(0.22);

  useEffect(() => {
    const still = mascotFrame(resolved, 0);
    const spring = mascotSpring(resolved);
    scale.value = withSpring(still.scale, spring);
    tilt.value = withSpring(still.tilt, spring);
    lean.value = withSpring(still.lean, spring);
    eyeOpen.value = withSpring(still.eyeOpen, spring);
    pupil.value = withSpring(still.pupil, spring);
    aura.value =
      resolved === "celebrating"
        ? withSequence(
            withTiming(still.aura, {
              duration: durations.quick,
              easing: Easing.out(Easing.quad),
            }),
            withRepeat(
              withTiming(0.3, { duration: 400, easing: Easing.inOut(Easing.quad) }),
              2,
              true,
            ),
          )
        : withSpring(still.aura, spring);

    // Restarted on every state change so a faster breath cannot leave the
    // figure stuck part-way through the previous cycle, and cancelled on
    // unmount so no frame callback outlives the component.
    clock.value = 0;
    clock.value = withRepeat(
      withTiming(1, { duration: still.breathPeriodMs, easing: Easing.linear }),
      -1,
      false,
    );
    return () => {
      cancelAnimation(clock);
      cancelAnimation(aura);
    };
  }, [aura, clock, eyeOpen, lean, pupil, resolved, scale, tilt]);

  const animatedStyle = useAnimatedStyle(() => {
    const frame = mascotFrame(resolved, clock.value * 10000);
    return {
      transform: [
        { translateY: frame.bob * size },
        { translateX: frame.lean * size },
        { rotate: `${tilt.value + frame.tilt * 0.5}deg` },
        { scale: scale.value },
      ],
    };
  });

  const palette = { sky: "#C8E7FF", sand: "#FDF0DF", lilac: "#F0EEFA" }[variant];
  const still = mascotFrame(resolved, 0);
  return (
    <Animated.View
      accessibilityRole="image"
      accessibilityLabel={mascotLabel(resolved)}
      style={[{ width: size, height: size }, style, animatedStyle]}
    >
      <Capybara
        size={size}
        eyeOpen={eyeOpen.value}
        pupil={pupil.value}
        fill={palette}
        aura={aura.value}
        auraScale={still.auraScale}
      />
    </Animated.View>
  );
}
