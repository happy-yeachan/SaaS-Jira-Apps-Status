import Link from "next/link";
import { Compass } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
      <Compass className="mb-4 h-12 w-12 text-muted-foreground/40" />
      <h1 className="text-base font-semibold">Page not found</h1>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        The page you&apos;re looking for doesn&apos;t exist. Head back to the dashboard.
      </p>
      <Link href="/" className={buttonVariants({ className: "mt-6" })}>
        Back to dashboard
      </Link>
    </main>
  );
}
