/** An error caused by input the user controls. Printed without a stack trace. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
