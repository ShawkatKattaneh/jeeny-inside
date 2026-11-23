import { CampusConfig, Persona } from "../../../shared/schemas";

/** Every response is validated with the same schemas the server uses. */
async function getJson<T>(url: string, parse: (v: unknown) => T): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return parse(await res.json());
}

export const fetchCampus = () => getJson("/api/campus", (v) => CampusConfig.parse(v));
export const fetchPersonas = () => getJson("/api/personas", (v) => Persona.array().parse(v));
