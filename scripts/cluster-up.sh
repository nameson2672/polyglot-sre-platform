#!/usr/bin/env bash
# Provision a fresh weekly Hetzner k3s dev cluster and bootstrap it end-to-end.
#
# What it does:
#   1. Creates the cluster via hetzner-k3s (infra/hetzner/cluster.yaml).
#   2. Injects the ONE bootstrap credential a fresh cluster needs: the Infisical
#      Machine Identity (read-only, dev-scoped) into the external-secrets namespace.
#   3. Installs Argo CD core, then applies the app-of-apps bootstrap.
#   4. Argo CD then syncs External Secrets Operator (wave 3) -> Infisical
#      ClusterSecretStore + ExternalSecrets (wave 4) -> real k8s Secrets appear.
#
# No secret material lives in git: the cluster pulls every secret from Infisical.
#
# Prereqs: hetzner-k3s, kubectl, and HCLOUD_TOKEN in your environment.
# Credentials are read from the gitignored .env (see .env.example):
#   INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ARGOCD_VERSION="${ARGOCD_VERSION:-stable}"

# ── Load credentials ─────────────────────────────────────────────────────────
if [[ -f .env ]]; then
  set -a; # shellcheck source=/dev/null
  source .env; set +a
fi

: "${INFISICAL_CLIENT_ID:?Set INFISICAL_CLIENT_ID (Infisical Machine Identity) in .env}"
: "${INFISICAL_CLIENT_SECRET:?Set INFISICAL_CLIENT_SECRET (Infisical Machine Identity) in .env}"

# ── 1. Provision cluster ─────────────────────────────────────────────────────
echo "==> Creating Hetzner k3s cluster..."
HCLOUD_TOKEN="$(security find-generic-password -s HCLOUD_TOKEN -w | tr -d '\n\r')" \
hetzner-k3s create --config infra/hetzner/cluster.yaml
export KUBECONFIG="${REPO_ROOT}/kubeconfig"

echo "==> Waiting for the API server to respond..."
until kubectl get --raw='/readyz' >/dev/null 2>&1; do sleep 3; done
echo "    API server ready."

# ── 2. Inject the single bootstrap credential ────────────────────────────────
echo "==> Creating Infisical machine-identity bootstrap secret..."
kubectl create namespace external-secrets --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic infisical-machine-identity \
  --namespace external-secrets \
  --from-literal=clientId="${INFISICAL_CLIENT_ID}" \
  --from-literal=clientSecret="${INFISICAL_CLIENT_SECRET}" \
  --dry-run=client -o yaml | kubectl apply -f -

# ── 3. Install Argo CD core + app-of-apps ────────────────────────────────────
echo "==> Installing Argo CD core (${ARGOCD_VERSION})..."
kubectl apply -f platform/argocd/bootstrap/namespace.yaml
kubectl apply -n argocd \
  -f "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml"

echo "==> Waiting for Argo CD to become available..."
kubectl rollout status -n argocd deploy/argocd-repo-server --timeout=300s
kubectl rollout status -n argocd deploy/argocd-server --timeout=300s

echo "==> Applying bootstrap (helm repos, ingress, app-of-apps)..."
kubectl apply -f platform/argocd/bootstrap/

cat <<'EOF'

┌─────────────────────────────────────────────────────────────────────┐
│  Cluster bootstrapped. Argo CD is now syncing:                      │
│    wave 3  →  External Secrets Operator                             │
│    wave 4  →  Infisical ClusterSecretStore + ExternalSecrets        │
│              → real k8s Secrets appear → workloads start            │
│                                                                     │
│  Watch progress:                                                    │
│    kubectl get applications -n argocd -w                            │
│    kubectl get clustersecretstore                                   │
│    kubectl get externalsecret -A                                    │
└─────────────────────────────────────────────────────────────────────┘
EOF
