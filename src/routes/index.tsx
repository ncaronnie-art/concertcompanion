import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

const steps = [
  {
    n: "01",
    title: "Upload your clips",
    desc: "Drag in a handful of phone videos from the show — as many as you like. Everything stays in your browser, nothing is uploaded.",
  },
  {
    n: "02",
    title: "Pick your format",
    desc: "Choose vertical 9:16 for Reels/TikTok, widescreen 16:9, square, or portrait 4:5. Then set the length — 15, 30, 45 or 60 seconds. The preview and the file both match.",
  },
  {
    n: "03",
    title: "Export your reel",
    desc: "The strongest moments are stitched into one high-quality MP4 with sound, ready to download and save to your camera roll. Regenerate any time for a different mix.",
  },
];

export default function Home() {
  return (
    <div className="min-h-dvh bg-[#0b0b12] text-white">
      {/* nav */}
      <header className="sticky top-0 z-20 border-b border-white/10 bg-[#0b0b12]/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-fuchsia-500 to-violet-600 text-base">
              ♪
            </span>
            <span>Concert Compass</span>
          </div>
          <nav className="flex items-center gap-4 text-sm text-white/60">
            <a href="#how" className="hover:text-white">How it works</a>
            <Link
              to="/create"
              className="rounded-full bg-gradient-to-r from-fuchsia-500 to-violet-600 px-4 py-1.5 font-semibold text-white hover:brightness-110"
            >
              Try the demo
            </Link>
          </nav>
        </div>
      </header>

      {/* hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_0%,rgba(168,85,247,0.25),transparent)]" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(40%_40%_at_85%_30%,rgba(217,70,239,0.15),transparent)]" />
        <div className="relative mx-auto max-w-6xl px-5 pt-24 pb-20 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm text-white/70">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            Auto-edited concert highlights
          </span>
          <h1 className="mx-auto mt-6 max-w-4xl text-5xl font-bold leading-[1.05] tracking-tight sm:text-7xl">
            Upload your concert videos.
            <br />
            <span className="bg-gradient-to-r from-fuchsia-400 to-violet-400 bg-clip-text text-transparent">
              Get your highlight reel.
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-white/60">
            Drop in your clips, pick your format — vertical 9:16 for Reels, or
            widescreen — set the length, and export a high-quality MP4 with
            sound, ready for your camera roll. No manual editing required.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <Link
              to="/create"
              className="rounded-2xl bg-gradient-to-r from-fuchsia-500 to-violet-600 px-8 py-4 text-lg font-semibold shadow-xl shadow-fuchsia-500/25 transition hover:brightness-110"
            >
              Start building your reel →
            </Link>
            <span className="text-sm text-white/40">
              Free · no account · runs in your browser
            </span>
          </div>

          {/* mock output preview: aspect + duration + export */}
          <div className="mx-auto mt-16 max-w-xl rounded-2xl border border-white/10 bg-white/5 p-3 shadow-2xl">
            <div className="flex items-center justify-center gap-3 bg-gradient-to-br from-[#1a1030] to-[#301040] rounded-xl px-4 py-4">
              <div className="flex h-28 items-center justify-center rounded border-2 border-fuchsia-400/60 bg-black/40 px-5">
                <span className="text-3xl">🎸</span>
                <span className="ml-2 text-xs text-fuchsia-300">9:16</span>
              </div>
              <div className="flex h-16 items-center justify-center rounded border border-white/20 bg-black/30 px-5">
                <span className="text-xs text-white/60">16:9 · 1:1 · 4:5</span>
              </div>
              <span className="text-2xl">→</span>
              <div className="flex items-center gap-1.5 rounded-lg bg-emerald-500/20 px-3 py-2">
                <span className="text-base">⬇</span>
                <span className="text-xs font-semibold text-emerald-300">.MP4</span>
              </div>
            </div>
            <div className="mt-2 flex justify-between text-[11px] text-white/40">
              <span>Pick your format &amp; length</span>
              <span className="text-fuchsia-300">Export with sound · saver</span>
            </div>
          </div>
        </div>
      </section>

      {/* how it works */}
      <section id="how" className="border-t border-white/10 bg-white/[0.02] py-20">
        <div className="mx-auto max-w-6xl px-5">
          <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
            How it works
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-center text-white/50">
            One click, end to end. Here's what happens when you drop in your clips.
          </p>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {steps.map((s) => (
              <div
                key={s.n}
                className="rounded-2xl border border-white/10 bg-white/5 p-6 transition hover:border-fuchsia-400/40"
              >
                <span className="text-sm font-bold text-fuchsia-400">{s.n}</span>
                <h3 className="mt-3 text-xl font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-white/55">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* honest caveat + CTA */}
      <section className="mx-auto max-w-3xl px-5 py-20 text-center">
        <h2 className="text-3xl font-bold tracking-tight">
          Honest about what it does
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-white/55">
          This MVP is a real working pipeline: it picks the best moments from
          your clips, trims the dead air, and stitches them into a rough cut you
          can play, then export as a high-quality MP4 with sound. Clip selection
          uses a light heuristic on the audio (harmonic/periodicity signal
          analysis, not ML) that steers away from loud crowd noise — genuine
          vocal separation is on the roadmap, not a feature today. For now it's a
          fun, fast way to turn a pile of clips into a shareable highlight reel.
        </p>
        <div className="mt-8">
          <Link
            to="/create"
            className="rounded-2xl bg-gradient-to-r from-fuchsia-500 to-violet-600 px-8 py-4 text-lg font-semibold shadow-xl shadow-fuchsia-500/25 transition hover:brightness-110"
          >
            Try the demo →
          </Link>
        </div>
      </section>

      <footer className="border-t border-white/10 py-8 text-center text-sm text-white/40">
        Concert Compass — edit-free concert highlight reels.
      </footer>
    </div>
  );
}
