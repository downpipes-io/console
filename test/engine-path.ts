// The engine checkout is not part of this repository.
export function engineRoots(_fromDir: string): string[] {
  return [];
}

export async function importFromEngine<T>(_fromDir: string, rel: string): Promise<T | null> {
  if (process.env.REQUIRE_ENGINE === "1") {
    console.error(`REFUSED: REQUIRE_ENGINE=1 and no engine checkout is available to supply ${rel}.`);
    process.exit(2);
  }
  return null;
}
