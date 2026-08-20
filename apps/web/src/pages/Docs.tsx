import { findProfileDocument, profileDocuments } from "@muster/core";
import { BookIcon, KeyIcon } from "@primer/octicons-react";
import { Link, useParams } from "react-router";

import { Panel } from "../components/Panel.tsx";

import type { DocBlock, ProfileDocument } from "@muster/core";
import type { JSX } from "react";

/**
 * The published profiles, in the console.
 *
 * The same documents the server renders as plain HTML at `/docs`, from the same
 * data in `@muster/core`: a vendor reading from a terminal and a participant
 * reading in the console are reading one document, not two that have to be kept
 * in step.
 *
 * The issuer identifier the documents are written around is this page's own
 * origin, because every public URL Muster advertises derives from
 * `MUSTER_PUBLIC_URL` and the console is served from it.
 *
 * @author John Grimes
 */

/**
 * Reads the issuer identifier the documents are written around.
 *
 * @returns the origin the console is served from
 */
const issuer = (): string => globalThis.location.origin;

/**
 * Renders one block of a document.
 *
 * @param props - the block to render
 * @returns the block
 */
function Block({
  block,
}: Readonly<{
  /** the block to render */
  block: DocBlock;
}>): JSX.Element {
  switch (block.kind) {
    case "paragraph": {
      return <p className="text-sm">{block.text}</p>;
    }
    case "list": {
      return (
        <ul className="list-disc pl-5 text-sm">
          {block.items.map((item) => (
            <li key={item} className="mb-1">
              {item}
            </li>
          ))}
        </ul>
      );
    }
    case "steps": {
      return (
        <ol className="list-decimal pl-5 text-sm">
          {block.items.map((item) => (
            <li key={item} className="mb-1">
              {item}
            </li>
          ))}
        </ol>
      );
    }
    case "table": {
      return (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                {block.columns.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row) => (
                <tr key={row.join("|")}>
                  {row.map((cell) => (
                    <td key={cell} className="align-top font-mono text-xs">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "code": {
      return (
        <figure className="flex flex-col gap-1">
          <figcaption className="text-xs text-base-content/60">
            {block.caption}
          </figcaption>
          <pre className="overflow-x-auto rounded bg-base-100 p-3 text-xs">
            <code>{block.text}</code>
          </pre>
        </figure>
      );
    }
  }
}

/**
 * Renders one profile.
 *
 * @param props - the document to render
 * @returns the sections
 */
function Profile({
  document,
}: Readonly<{
  /** the document to render */
  document: ProfileDocument;
}>): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link to="/docs" className="btn btn-ghost btn-sm">
          <BookIcon size={16} />
          All profiles
        </Link>
      </div>
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold sm:text-3xl">{document.title}</h1>
        <p className="text-sm text-base-content/70">{document.summary}</p>
      </header>
      {document.sections.map((section) => (
        <Panel key={section.heading} title={section.heading}>
          <div className="flex flex-col gap-3">
            {section.blocks.map((block, index) => (
              <Block
                key={`${section.heading}-${String(index)}`}
                block={block}
              />
            ))}
          </div>
        </Panel>
      ))}
      <Panel title="Keys" icon={<KeyIcon size={18} />}>
        <p className="text-sm">
          The signing keys these profiles refer to are published at{" "}
          <a className="link font-mono" href="/.well-known/jwks.json">
            /.well-known/jwks.json
          </a>
          .
        </p>
      </Panel>
    </div>
  );
}

/**
 * The documentation screen: the index, or one profile.
 *
 * @returns the screen
 * @author John Grimes
 */
export function Docs(): JSX.Element {
  const { slug } = useParams();
  const documents = profileDocuments(issuer());

  if (slug !== undefined) {
    const document = findProfileDocument(issuer(), slug);
    if (document === undefined) {
      return (
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-bold sm:text-3xl">No such profile</h1>
          <p className="text-sm text-base-content/70">
            Muster publishes no profile under that name.
          </p>
          <Link to="/docs" className="btn btn-sm self-start">
            <BookIcon size={16} />
            The profiles it does publish
          </Link>
        </div>
      );
    }
    return <Profile document={document} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold sm:text-3xl">Muster profiles</h1>
        <p className="text-sm text-base-content/70">
          What a participating server implements in order to accept a client
          Muster vouches for, or a permission ticket Muster minted. Both are
          readable without an account, and so are the signing keys.
        </p>
      </header>
      {documents.map((document) => (
        <Panel
          key={document.slug}
          title={document.title}
          icon={<BookIcon size={18} />}
          description={document.summary}
        >
          <Link
            to={`/docs/${document.slug}`}
            className="btn btn-primary btn-sm self-start"
          >
            Read the profile
          </Link>
        </Panel>
      ))}
      <Panel title="Keys" icon={<KeyIcon size={18} />}>
        <p className="text-sm">
          Signing keys are published at{" "}
          <a className="link font-mono" href="/.well-known/jwks.json">
            /.well-known/jwks.json
          </a>
          , with an identifier on each key so that a rotation does not
          invalidate artefacts already in flight.
        </p>
      </Panel>
    </div>
  );
}
