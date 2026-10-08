# Ringers

**Championship horseshoe pitching for your phone — full 3D, real physics, regulation everything.**

Ringers is a mobile-first 3D horseshoe game built for people who actually pitch. Courts, stakes, pits and
shoes follow the NHPA rule book; shoes fly, flip and land under a purpose-built rigid-body simulation; and the
game is played the way tournaments are played — cancellation or count-all scoring, two shoes a pitcher, walk
to the other end, up through a 64-pitcher world championship.

## Highlights

- **Physics you can feel.** Each shoe is a rigid body with an inertia tensor integrated from its forged shape
  (gyroscopic precession included). The perfect delivery is a *single flip*: one end-over-end revolution that
  arrives flat with the heels open to the stake. Under-rotate and the heels dig in; over-rotate and the toe slaps
  down; wobble and the shoe lands on edge. 1¼ and 1¾ turns are modelled too.
- **Real courts.** Stakes 40 ft apart (or the 27 ft foul line for women, elders and juniors), 1″ steel stakes
  standing 15″ and leaning 3″ toward the opposite stake, 36″ × 60″ pits in 6 ft boxes, backboards, foul lines.
- **Sand and blue clay.** The fill is a firm base under loose material that plows and stops shoes. In 3D the
  pit is a deformable heightfield: shoes carve trenches, impacts leave craters with thrown-up rims, fresh fill is
  darker, and sand sprays and dust puffs on every landing.
- **NHPA judging.** Ringers use the straightedge rule (a line across both heel calks must clear the stake);
  shoes within 6″ are in count; leaners count; backboard shoes are foul. Cancellation scoring (ringers cancel,
  one scorer per inning, closest shoe 1, two closest 2, ringer + closest 4, double ringer 6) and count-all.
- **The pro shop.** Six (fictional) brands with soft, medium or hard steel — which really changes how shoes
  die on the stake — four legal shapes (Classic, Hook Heel, Wide Body, Tournament Taper), five weights from
  2 lb 2 oz to the 2 lb 10 oz limit, and painted, forged, chrome, copper and gold finishes with stamped brands.
  Every combination is verified against NHPA size, opening and weight limits in the test suite.
- **A full championship.** 64 pitchers: sixteen round-robin pools of four, then a 32-pitcher single-elimination
  bracket to the title. AI opponents throw through the same physics with skill-calibrated release errors.
- **Broadcast presentation.** Every shoe is followed through the air in slow motion by a chase camera so you
  can read the flip and where it will land (tap to speed it up). Your pitcher finishes the delivery in third
  person as the shoe leaves the hand. Instant replay of ringers with the clangs re-played, crowds in the
  bleachers that react, scoreboards, morning/afternoon/sunset/night lights.
- **High-end rendering.** Pitchers and spectators are seamless sculpted bodies (a signed-distance sculpt
  meshed with surface nets in a Web Worker, with baked ambient occlusion, cloth sheen and skinning), shoes use
  clear-coat paint, polished steel and chrome lit by an HDR reflection probe with bloom on the glints, the lawn
  is tens of thousands of instanced 3D grass blades swaying in the wind, trees are leafy, and the sky has
  drifting clouds.
- **All synthesised.** No bitmap or audio assets: textures are generated at load time and every sound — the
  stake's ring is modal synthesis of a struck steel rod — is synthesised with WebAudio.

## Playing

1. **Pull down** anywhere on the lower screen — that is your backswing. How far you pull sets the power; stop
   in the green zone on the meter.
2. **Push up** in a straight line. Drift sideways and the shoe goes off line; a wobbly stroke wobbles the shoe.
3. **Lift your finger on the green release line** (where you first touched). On the line is one perfect flip;
   early under-rotates, late over-rotates.

The readout after each shoe tells you the flips, power and line so you can groove your delivery. Difficulty
(Amateur, Pro, World Class) scales how much of your gesture error reaches the shoe.

## Development

```bash
npm install
npm run dev        # Vite dev server (open on your phone via the LAN URL)
npm test           # rules, tournament, equipment legality and physics regression tests
npm run build      # type-check + production build into dist/
```

`?warp=N` on the URL lets slow software-rendered test runs keep real time.

### Project layout

| Path | What lives there |
| --- | --- |
| `src/core` | Rule-book constants, equipment catalogue, shoe geometry, judging and scoring |
| `src/physics` | Rigid-body engine, throw model, release-error model, headless simulation |
| `src/game` | App controller, match flow, AI, roster, tournament, persistence |
| `src/render` | Three.js stage, court, deformable pits, shoe meshes, pitchers, environment, particles |
| `src/input` | Touch delivery control |
| `src/audio` | Synthesised sound |
| `src/ui` | Screens, HUD and styles |
| `tests` | Vitest suites |

## Packages

The **Package** workflow (`.github/workflows/package.yml`) builds everything on GitHub:

| File | What it is |
| --- | --- |
| `Ringers-<version>.apk` | Android app. Download it on an Android phone and open it to install. |
| `Ringers-<version>-release.aab` | Android App Bundle for the Google Play Console. |
| `Ringers-<version>-web.zip` | The web version. Unzip onto any static web host; it installs to the home screen and works offline. |

Every push uploads these as workflow artifacts. Pushing a version tag publishes a GitHub Release:

```bash
git tag v1.0.1 && git push origin v1.0.1
```

**Signing.** Without secrets, the APK is debug-signed (fine for sideloading; uninstall before installing a
build from a different machine) and the AAB is unsigned. To sign release builds, add these repository secrets:
`ANDROID_KEYSTORE_BASE64` (the keystore, base64-encoded), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and
`ANDROID_KEY_PASSWORD`. Create a keystore with:

```bash
keytool -genkeypair -v -keystore ringers.jks -alias ringers -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 ringers.jks   # paste as ANDROID_KEYSTORE_BASE64
```

**iPhone.** The Xcode project lives in `ios/`. On a Mac with Xcode:

```bash
npm ci && npm run build && npx cap sync ios
npx cap open ios   # choose your team under Signing & Capabilities, then Run or Product → Archive
```

Installing on an iPhone or shipping to the App Store needs an Apple Developer account.

**Building Android locally** (Android Studio or the Android SDK plus JDK 21):

```bash
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug   # app/build/outputs/apk/debug/app-debug.apk
```

## Notes

Brand names in the game are fictional. Court, stake, pit and shoe dimensions follow the NHPA Official Rules.
