import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    model: process.env.NVIDIA_MODEL || "modello non configurato"
  });
}


