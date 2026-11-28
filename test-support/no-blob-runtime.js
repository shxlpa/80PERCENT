import { registerHooks } from 'node:module';
registerHooks({resolve(specifier, context, next) {
  if (specifier === '@vercel/blob' || /(?:^|\/)storage\.js$/.test(specifier)) throw new Error('Blob import forbidden in private runtime');
  return next(specifier, context);
}});
globalThis.fetch = async () => { throw new Error('External fetch forbidden in fixture runtime'); };
