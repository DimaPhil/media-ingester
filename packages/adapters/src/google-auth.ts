import { GoogleAuth } from 'google-auth-library';

export async function googleAccessToken(credentials?: Record<string, unknown>): Promise<string> {
  const auth = new GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
  const token = await auth.getAccessToken();
  if (!token) throw new Error('Google credentials did not yield an access token');
  return token;
}
