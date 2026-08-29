import WebSocket from "ws";

// A joins room, B joins room, B sends, A must receive. Definitive relay test.
const room = "probe-room-" + Date.now();

const a = new WebSocket("ws://127.0.0.1:4378");
a.on("open", () => {
  a.send(JSON.stringify({ room, from: "A", payload: "" }));
  setTimeout(() => {
    const b = new WebSocket("ws://127.0.0.1:4378");
    b.on("open", () => {
      b.send(JSON.stringify({ room, from: "B", payload: "hello-from-B" }));
    });
    b.on("message", (d) => console.log("B received:", d.toString().slice(0, 50)));
  }, 300);
});
a.on("message", (d) => {
  console.log("A received:", d.toString().slice(0, 50));
  console.log("RELAY ROUTING: OK");
  process.exit(0);
});
setTimeout(() => {
  console.log("RELAY ROUTING: FAILED (A never got B's frame)");
  process.exit(1);
}, 4000);
