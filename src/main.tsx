import { mountApp } from "./App";

const root = document.getElementById("root");

if (!root) {
  throw new Error("missing root element");
}

mountApp(root);
