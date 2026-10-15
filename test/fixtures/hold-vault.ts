import { AccountVault } from "../../storage/vault.ts";

const root = process.argv[2];
if (!root || !process.send) throw new Error("This fixture needs its own vault and IPC channel");
const vault = new AccountVault(root);
await vault.modify(async (current) => {
  process.send?.({ type: "locked" });
  setInterval(() => {}, 1000);
  await new Promise<void>(() => {});
  return current;
});
