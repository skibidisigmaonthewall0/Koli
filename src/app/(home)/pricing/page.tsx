"use client";

import Image from "next/image";
import { Check } from "lucide-react";

const plans = [
  {
    name: "Free",
    price: "$0",
    period: "/ month",
    description: "Perfect for experimenting and personal projects.",
    features: [
      "100 AI generations per month",
      "Live sandbox preview",
      "Code explorer",
      "All AI templates",
      "Community support",
    ],
    highlight: false,
    cta: "Get Started",
  },
];

export default function PricingPage() {
  return (
    <div className="flex flex-col max-w-3xl mx-auto w-full">
      <section className="space-y-6 pt-[16vh] 2xl:pt-48">
        <div className="flex flex-col items-center gap-2">
          <Image
            src="/logo.svg"
            alt="lovable-clone"
            height={50}
            width={50}
            className="hidden md:block"
          />
          <h1 className="text-xl md:text-3xl font-bold text-center">Pricing</h1>
          <p className="text-muted-foreground text-center text-sm md:text-base">
            Choose the plan that fits your needs
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 mt-8">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className="rounded-lg border bg-card p-8 shadow-sm flex flex-col gap-4"
            >
              <div>
                <h2 className="text-2xl font-bold">{plan.name}</h2>
                <p className="text-muted-foreground text-sm mt-1">
                  {plan.description}
                </p>
              </div>

              <div className="flex items-end gap-1">
                <span className="text-4xl font-bold">{plan.price}</span>
                <span className="text-muted-foreground mb-1">
                  {plan.period}
                </span>
              </div>

              <ul className="space-y-2">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2 text-sm">
                    <Check className="h-4 w-4 text-green-500 shrink-0" />
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
