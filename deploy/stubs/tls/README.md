# A throwaway TLS keypair for the local stack's stubs

`stub.crt` and `stub.key` are a self-signed certificate for the compose network's
`stub-server` and `stub-holder`, valid for ten years, and **the private key is in
this repository on purpose**. It protects nothing: it names two services that
exist only for the duration of a development stack, holds no data, and is trusted
by exactly one container - Muster's, through `NODE_EXTRA_CA_CERTS`.

It is here rather than generated at start-up because a generated one needs an
extra service, an `openssl` image and a shared volume, and every one of those is a
thing that can fail on somebody else's machine. The same reasoning as
`deploy/postgres/init/10-serving-role.sh`, whose role password is also in the
repository.

## Why the stubs need TLS at all

`serverProfile.registrationEndpoint` and `fhirBaseUrl` must be `https` - the Zod
schema in `packages/contracts/src/directory.ts` enforces it, and weakening that
so a stub could be entered over plain HTTP would weaken it for every real entry
too. So the stub serves TLS, and the compose stack points
`MUSTER_OUTBOUND_ALLOWED_HOSTS` at it, which is what exempts a private compose
address from the outbound guard (`apps/server/src/outbound/outboundFetch.ts`).
Both halves are needed and neither is a default.

## Regenerating it

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout stub.key -out stub.crt -days 3650 \
  -subj "/CN=stub-server" \
  -addext "subjectAltName=DNS:stub-server,DNS:stub-holder,DNS:localhost,IP:127.0.0.1"
```

Never use this keypair anywhere a real client could reach.
