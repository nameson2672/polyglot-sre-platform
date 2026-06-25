#!/usr/bin/env bash
# Tear down the Hetzner k3s dev cluster created by scripts/cluster-up.sh and
# clean up everything it leaves behind.
#
# What it does:
#   1. (if the cluster is still reachable) Deletes LoadBalancer Services and
#      PersistentVolumeClaims FIRST, so the Hetzner CCM/CSI release the cloud
#      load balancers + volumes they provisioned. hetzner-k3s does NOT remove
#      these — skipping this step leaves orphaned resources that keep billing.
#   2. Deletes the cluster (servers, private network, firewall) via hetzner-k3s.
#   3. Removes the local ./kubeconfig and its kube-context entries.
#
# Destructive + irreversible: this DELETES the cluster and all PVC data.
#
# Prereqs: hetzner-k3s, kubectl. HCLOUD_TOKEN is read from the macOS keychain
# (same as cluster-up.sh). Run non-interactively with:  FORCE=1 make cluster-down
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CONFIG="infra/hetzner/cluster.yaml"
export KUBECONFIG="${REPO_ROOT}/kubeconfig"

CLUSTER_NAME="$(grep -E '^cluster_name:' "$CONFIG" | sed -E 's/.*"(.*)".*/\1/')"
[[ -n "$CLUSTER_NAME" ]] || { echo "Could not read cluster_name from $CONFIG" >&2; exit 1; }

# ── Confirm (skip with FORCE=1) ──────────────────────────────────────────────
if [[ "${FORCE:-0}" != "1" ]]; then
  echo "⚠  This will PERMANENTLY DELETE the Hetzner cluster '${CLUSTER_NAME}'"
  echo "   and all its volumes/data. This cannot be undone."
  read -r -p "   Type the cluster name to confirm: " reply
  [[ "$reply" == "$CLUSTER_NAME" ]] || { echo "Aborted."; exit 1; }
fi

# ── 1. Release cloud resources the CCM/CSI provisioned (best-effort) ──────────
if kubectl cluster-info --request-timeout=10s >/dev/null 2>&1; then
  echo "==> Cluster reachable — releasing LoadBalancers and volumes first..."

  # LoadBalancer Services -> hcloud CCM deletes the load balancers
  kubectl get svc -A \
    -o jsonpath='{range .items[?(@.spec.type=="LoadBalancer")]}{.metadata.namespace} {.metadata.name}{"\n"}{end}' \
    2>/dev/null | while read -r ns name; do
      [[ -n "$ns" ]] && { echo "    deleting svc $ns/$name"; kubectl delete svc -n "$ns" "$name" --wait=false || true; }
    done

  # PVCs -> hcloud CSI deletes the volumes (reclaimPolicy Delete)
  echo "    deleting all PersistentVolumeClaims..."
  kubectl delete pvc --all --all-namespaces --wait=false || true

  # Give the controllers time to actually delete the cloud resources before we
  # remove the nodes that run them.
  echo "==> Waiting for LoadBalancers + volumes to be released (max 180s)..."
  deadline=$((SECONDS + 180))
  while :; do
    lbs=$(kubectl get svc -A -o jsonpath='{range .items[?(@.spec.type=="LoadBalancer")]}x{"\n"}{end}' 2>/dev/null | grep -c x || true)
    pvcs=$(kubectl get pvc -A --no-headers 2>/dev/null | wc -l | tr -d ' ')
    [[ "${lbs:-0}" -eq 0 && "${pvcs:-0}" -eq 0 ]] && { echo "    all released."; break; }
    (( SECONDS > deadline )) && { echo "    ⚠ timed out (lbs=${lbs} pvcs=${pvcs}); verify in Hetzner console after teardown."; break; }
    sleep 5
  done
else
  echo "==> Cluster not reachable — skipping in-cluster cleanup."
  echo "    ⚠ If it ever had a LoadBalancer or Postgres volume, check the Hetzner"
  echo "      console for orphaned load balancers / volumes after teardown."
fi

# ── 2. Delete the cluster ────────────────────────────────────────────────────
echo "==> Deleting Hetzner k3s cluster '${CLUSTER_NAME}'..."
# Pipe the cluster name in case hetzner-k3s asks to confirm; ignored otherwise.
printf '%s\n' "$CLUSTER_NAME" | \
  HCLOUD_TOKEN="$(security find-generic-password -s HCLOUD_TOKEN -w | tr -d '\n\r')" \
  hetzner-k3s delete --config "$CONFIG"

# ── 3. Local cleanup ─────────────────────────────────────────────────────────
echo "==> Cleaning local kubeconfig + context..."
rm -f "${REPO_ROOT}/kubeconfig"
kubectl config delete-context "${CLUSTER_NAME}-master1" 2>/dev/null || true
kubectl config delete-cluster "${CLUSTER_NAME}-master1" 2>/dev/null || true
kubectl config unset "users.${CLUSTER_NAME}-master1" 2>/dev/null || true

cat <<EOF

┌─────────────────────────────────────────────────────────────────────┐
│  Cluster '${CLUSTER_NAME}' torn down.
│  Recommended: open the Hetzner Cloud console and confirm there are   │
│  no leftover Volumes or Load Balancers before you stop watching.     │
└─────────────────────────────────────────────────────────────────────┘
EOF
