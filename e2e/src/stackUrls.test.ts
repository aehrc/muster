/**
 * Where the suite looks for the stack.
 *
 * Worth a unit test rather than being left to the first failing spec, because getting it
 * wrong produces a suite that cannot connect to anything and says only that a page did not
 * load. The internal-versus-external distinction is the part that is easy to get wrong and
 * expensive to debug: an entry typed into Muster pointing at `localhost` reaches Muster's own
 * container, not the stub.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import { resolveStackUrls } from "./stackUrls.js";

describe("resolveStackUrls", () => {
  it("uses the ports the compose file publishes by default", () => {
    const urls = resolveStackUrls({});
    expect(urls.muster).toBe("http://localhost:3000");
    expect(urls.registrationStub).toBe("https://localhost:8443");
    expect(urls.dataHolder).toBe("https://localhost:8444");
  });

  it("follows the environment when the stack has been moved", () => {
    // CI runs the stack on non-default ports precisely so that an address hard-coded
    // anywhere in the suite fails there.
    const urls = resolveStackUrls({
      MUSTER_PORT: "3100",
      STUB_SERVER_PORT: "9443",
      STUB_HOLDER_PORT: "9444",
    });
    expect(urls.muster).toBe("http://localhost:3100");
    expect(urls.registrationStub).toBe("https://localhost:9443");
    expect(urls.dataHolder).toBe("https://localhost:9444");
  });

  it("treats an exported-but-cleared variable as unset", () => {
    // Otherwise the port becomes the empty string and the URL fails much later than the
    // mistake.
    expect(resolveStackUrls({ MUSTER_PORT: "" }).muster).toBe(
      "http://localhost:3000",
    );
  });

  it("lets a base URL win outright over the port", () => {
    // A stack somewhere other than localhost is not expressible as a port.
    expect(
      resolveStackUrls({
        MUSTER_BASE_URL: "https://muster.example.org/",
        MUSTER_PORT: "3100",
      }).muster,
    ).toBe("https://muster.example.org/");
  });

  it("addresses the stubs by their compose names for anything Muster will fetch", () => {
    // These are the addresses typed into Muster, so they are resolved inside the compose
    // network - and they are the names the stubs' certificate carries, which is what makes
    // Muster's verification checks against them succeed. Moving the published ports must not
    // move them.
    const urls = resolveStackUrls({
      STUB_SERVER_PORT: "9443",
      STUB_HOLDER_PORT: "9444",
    });
    expect(urls.registrationStubInternal).toBe("https://stub-server:8443");
    expect(urls.dataHolderInternal).toBe("https://stub-holder:8444");
  });
});
