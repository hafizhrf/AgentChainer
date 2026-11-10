import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shortPath } from "./shortPath.ts";

const win = (p: string) => p.replaceAll("/", "\\");

describe("a folder's path where space is short (UX-20)", () => {
  it("writes the home folder as ~, on Windows and elsewhere", () => {
    assert.equal(shortPath(win("C:/Users/me"), win("C:/Users/me")), "~");
    assert.equal(shortPath(win("C:/Users/me/code/app"), win("C:/Users/me")), win("~/code/app"));
    assert.equal(shortPath("/home/me/code/app/", "/home/me"), "~/code/app");
    assert.equal(shortPath("/home/meadow/app", "/home/me"), "/home/meadow/app", "a longer name isn't the home folder");
  });

  it("leaves out the middle of a long path, keeping where it starts and its last two folders", () => {
    const long = win("C:/Users/me/AppData/Local/Temp/claude/d--Personal/7b405934-88e2/scratchpad/ux12-ws");
    assert.equal(shortPath(long, win("C:/Users/me")), win("~/…/scratchpad/ux12-ws"));
    assert.equal(shortPath(win("D:/Kerja/Kyou/hanamaru-next"), null), win("D:/Kerja/Kyou/hanamaru-next"));
  });
});
