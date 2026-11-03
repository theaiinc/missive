-- Register Valefront as a hosted mail domain.
INSERT INTO domains (name) VALUES ('valefront.com') ON CONFLICT (name) DO NOTHING;
