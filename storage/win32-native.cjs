"use strict";

// One disposable child owns the native allocations. Only its private pipes carry
// data; a blocked native call can be terminated without blocking the Pi process.
const { isAbsolute, normalize } = require("node:path");

function nativeApi() {
  const koffi = require("koffi");
  const kernel = koffi.load("kernel32.dll");
  const free = kernel.func("void * __stdcall LocalFree(void *memory)");
  const load = kernel.func("void * __stdcall LoadLibraryExW(str16 name, void *file, uint32_t flags)");
  const address = kernel.func("void * __stdcall GetProcAddress(void *module, str name)");
  const unload = kernel.func("int32_t __stdcall FreeLibrary(void *module)");
  const modules = [];
  function systemFunction(dll, name, result, parameters) {
    const module = load(dll, null, 0x800); // LOAD_LIBRARY_SEARCH_SYSTEM32
    if (!module) throw new Error("native");
    modules.push(module);
    const pointer = address(module, name);
    if (!pointer) throw new Error("native");
    const prototype = koffi.proto("__stdcall", name, result, parameters);
    return (...args) => koffi.call(pointer, prototype, ...args);
  }
  const outPointer = koffi.out(koffi.pointer("void *"));
  const outDword = koffi.out(koffi.pointer("uint32_t"));
  const blob = koffi.struct("RotationBlob", { cbData: "uint32_t", pbData: "void *" });
  const attributes = koffi.struct("RotationSecurityAttributes", {
    nLength: "uint32_t", lpSecurityDescriptor: "void *", bInheritHandle: "int32_t",
  });
  const sidAttributes = koffi.struct("RotationSidAttributes", { Sid: "void *", Attributes: "uint32_t" });
  const protect = systemFunction("crypt32.dll", "CryptProtectData", "int32_t", [
    koffi.pointer(blob), "void *", "void *", "void *", "void *", "uint32_t", koffi.out(koffi.pointer(blob)),
  ]);
  const unprotect = systemFunction("crypt32.dll", "CryptUnprotectData", "int32_t", [
    koffi.pointer(blob), "void *", "void *", "void *", "void *", "uint32_t", koffi.out(koffi.pointer(blob)),
  ]);
  const processHandle = kernel.func("void * __stdcall GetCurrentProcess()");
  const close = kernel.func("int32_t __stdcall CloseHandle(void *handle)");
  const openToken = systemFunction("advapi32.dll", "OpenProcessToken", "int32_t", ["void *", "uint32_t", outPointer]);
  const tokenInfo = systemFunction("advapi32.dll", "GetTokenInformation", "int32_t", ["void *", "uint32_t", "void *", "uint32_t", outDword]);
  const sidString = systemFunction("advapi32.dll", "ConvertSidToStringSidW", "int32_t", ["void *", outPointer]);
  const fromSddl = systemFunction("advapi32.dll", "ConvertStringSecurityDescriptorToSecurityDescriptorW", "int32_t", ["str16", "uint32_t", outPointer, "void *"]);
  const toSddl = systemFunction("advapi32.dll", "ConvertSecurityDescriptorToStringSecurityDescriptorW", "int32_t", ["void *", "uint32_t", "uint32_t", outPointer, outDword]);
  const namedSecurity = systemFunction("advapi32.dll", "GetNamedSecurityInfoW", "uint32_t", ["str16", "uint32_t", "uint32_t", "void *", "void *", "void *", "void *", outPointer]);
  const createDirectory = kernel.func("CreateDirectoryW", "int32_t", ["str16", koffi.pointer(attributes)]);

  function currentSid() {
    const token = [null];
    if (!openToken(processHandle(), 8, token)) throw new Error("native");
    try {
      const required = [0];
      tokenInfo(token[0], 1, null, 0, required);
      if (required[0] < koffi.sizeof(sidAttributes) || required[0] > 65536) throw new Error("native");
      const buffer = Buffer.alloc(required[0]);
      if (!tokenInfo(token[0], 1, buffer, buffer.length, required)) throw new Error("native");
      const user = koffi.decode(buffer, sidAttributes);
      const text = [null];
      if (!sidString(user.Sid, text)) throw new Error("native");
      try {
        // The API returns the string address, not an address of a string
        // pointer. Generic decode(ptr, "str16") would dereference it again.
        const sid = koffi.decode.string16(text[0]);
        if (typeof sid !== "string" || !/^S-1-(?:\d+-)+\d+$/.test(sid) || sid.length > 184) throw new Error("native");
        return sid;
      } finally { free(text[0]); }
    } finally { close(token[0]); }
  }

  function verifySecurity(path, sid, directory) {
    const descriptor = [null];
    if (namedSecurity(path, 1, 5, null, null, null, null, descriptor) !== 0) throw new Error("acl");
    try {
      const text = [null];
      const length = [0];
      if (!toSddl(descriptor[0], 1, 5, text, length)) throw new Error("acl");
      try {
        if (length[0] < 1 || length[0] > 4096) throw new Error("acl");
        const sddl = Buffer.from(koffi.view(text[0], length[0] * 2)).toString("utf16le").replace(/\0$/, "");
        const expected = directory
          ? `O:${sid}D:P(A;OICI;FA;;;${sid})`
          : `O:${sid}D:(A;ID;FA;;;${sid})`;
        // Accept only the current user's full-access ACE, never inherited
        // broad groups. The directory must also block parent inheritance.
        if (sddl.replace("D:PAI", "D:P").replace("D:AI", "D:") !== expected) throw new Error("acl");
      } finally { free(text[0]); }
    } finally { free(descriptor[0]); }
  }

  return {
    directory(path) {
      if (typeof path !== "string" || !isAbsolute(path) || !/^[a-z]:[\\/]/i.test(path) || path.includes("\0")) throw new Error("path");
      path = normalize(path);
      const sid = currentSid();
      const descriptor = [null];
      if (!fromSddl(`O:${sid}D:P(A;OICI;FA;;;${sid})`, 1, descriptor, null)) throw new Error("acl");
      try {
        createDirectory(path, { nLength: koffi.sizeof(attributes), lpSecurityDescriptor: descriptor[0], bInheritHandle: 0 });
        // Success and an existing directory both require the effective descriptor
        // to match. A creation failure must never weaken an existing ACL.
        verifySecurity(path, sid, true);
      } finally { free(descriptor[0]); }
      return null;
    },
    file(path) {
      if (typeof path !== "string" || !/^[a-z]:[\\/]/i.test(path) || path.includes("\0")) throw new Error("path");
      verifySecurity(normalize(path), currentSid(), false);
      return null;
    },
    crypt(operation, encoded) {
      if (typeof encoded !== "string" || encoded.length > 32768) throw new Error("input");
      const input = Buffer.from(encoded, "base64");
      if (input.toString("base64") !== encoded || input.length === 0 || input.length > 16384) throw new Error("input");
      const output = { cbData: 0, pbData: null };
      let view;
      try {
        const fn = operation === "protect" ? protect : unprotect;
        if (!fn({ cbData: input.length, pbData: input }, null, null, null, null, 1, output)) throw new Error("native");
        // CRYPTPROTECT_UI_FORBIDDEN; user scope, no LOCAL_MACHINE or prompt.
        if (!output.pbData || output.cbData < 1 || output.cbData > 16384) throw new Error("native");
        view = Buffer.from(koffi.view(output.pbData, output.cbData));
        return Buffer.from(view).toString("base64");
      } finally {
        input.fill(0);
        view?.fill(0);
        if (output.pbData) free(output.pbData); // DPAPI allocations require LocalFree, not koffi.free.
      }
    },
    dispose() { for (const module of modules.reverse()) unload(module); },
  };
}

module.exports = { nativeApi };
