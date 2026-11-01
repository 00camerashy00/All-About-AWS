import { redirect } from "next/navigation";

// Overview is the landing screen again now that it shows live data.
export default function Home() {
  redirect("/overview");
}
