import { SpotsExplorer } from "@/components/spots-explorer";

export const metadata = { title: "Bornes à proximité" };

export default function MapPage() {
  return (
    <section>
      <h1 className="text-2xl font-bold">Bornes à proximité</h1>
      <p className="mt-1 text-sm text-white/60">Spots partagés par des particuliers autour de vous.</p>
      <SpotsExplorer />
    </section>
  );
}
