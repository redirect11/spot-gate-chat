import ChatApp from "@/components/ChatApp";

// ChatApp is a client component; rendering it directly (instead of a
// dynamic import with ssr:false) lets Next prerender its initial loading
// screen into the static HTML. Without this the exported page ships an empty
// body (BAILOUT_TO_CLIENT_SIDE_RENDERING) and shows only a dark background
// until the JS chunk loads — which on iOS Safari could leave it blank.
export default function Home() {
  return <ChatApp />;
}
