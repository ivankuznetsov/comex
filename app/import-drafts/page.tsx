import { ImportHandoff } from '../connections/ImportHandoff';

// Separate entry point for an existing, explicitly initiated local import.
export default function ImportDrafts() {
  return <main className="mx-auto max-w-xl px-5 py-12">
    <h1 className="font-display text-4xl uppercase">Import local drafts</h1>
    <ImportHandoff />
    <a href="/drafts" className="mt-8 inline-block underline">Back to drafts</a>
  </main>;
}
