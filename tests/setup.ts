// Tests use isolated temporary stores and never write to a user's Memoir store.
process.env.MEMOIR_AUTO_SAVE ??= "1";
