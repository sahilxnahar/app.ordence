import { handleUserUpdated } from "../app/api/webhooks/clerk/_handlers";

async function main() {
  const user = {
    id: `user-clerk-${crypto.randomUUID()}`,
    primary_email_address_id: "eml-primary",
    email_addresses: [
      { id: "eml-primary", email_address: `test@example.invalid` },
    ],
    updated_attributes: ["password", "email_addresses"],
  };
  try {
    await handleUserUpdated(user as never);
    console.log("HANDLER RETURNED OK");
  } catch (err) {
    console.error("HANDLER THREW:", err);
  }
  process.exit(0);
}

main();
