"""
Simulateur LIF du cerveau entier de la drosophile, en numpy.

Reimplementation fidele du modele de Shiu et al. (Nature 2024) tel qu'il est
code dans le depot eonsystemspbc/fly-brain. La reference suivie pas a pas est
`code/run_pytorch.py` (backend PyTorch, valide contre Brian2 CPU qui fait
office de verite terrain dans ce depot).

Regle de mise a jour, a chaque pas de temps de 0,1 ms :

    poisson      = bernoulli(taux * dt/1000) * f_poi
    v_stim       = w_syn * poisson
    entree_rec   = w_syn * (W_sortant[spikes_precedents].somme())

    refrac       = 0 si le neurone vient de spiker, sinon refrac + 1
    actif        = refrac >= refrac_steps          (0 pour les neurones stimules)
    g_new        = g * (1 - dt/tau_syn) + tampon_retard[tete] * actif
    tampon[tete] = entree_rec                      (retard de 1,8 ms)

    v           += v_stim
    v           += (dt/tau_mem) * (g_ancien - (v - v_repos))
    spike        = v > v_seuil
    v            = v_reset la ou spike
    g_new        = 0 la ou spike

Points a retenir : pas de plasticite, pas de neuromodulation, pas d'etat
interne, tous les neurones identiques. Seul le cablage les differencie.
"""
import numpy as np

DT_MS = 0.1

DEFAULT_PARAMS = {
    'v_rest': -52.0,   # mV, potentiel de repos      (Kakaria & de Bivort 2017)
    'v_reset': -52.0,  # mV, potentiel apres spike
    'v_th': -45.0,     # mV, seuil de decharge
    'tau_mem': 20.0,   # ms, constante de temps membranaire
    'tau_syn': 5.0,    # ms, constante de temps synaptique (Jurgensen et al.)
    't_rfc': 2.2,      # ms, periode refractaire        (Lazar et al. 2021)
    't_delay': 1.8,    # ms, delai synaptique           (Paul et al. 2015)
    'w_syn': 0.275,    # mV par synapse  <- SEUL parametre libre du modele
    'f_poi': 250.0,    # facteur d'echelle de la stimulation de Poisson
}


class Connectome:
    """Graphe synaptique stocke en CSR indexe par neurone presynaptique."""

    def __init__(self, n, indptr, indices, weights):
        self.n = int(n)
        self.indptr = np.ascontiguousarray(indptr, dtype=np.int64)
        self.indices = np.ascontiguousarray(indices, dtype=np.int32)
        self.weights = np.ascontiguousarray(weights, dtype=np.float32)

    @classmethod
    def from_edges(cls, n, pre, post, weight):
        order = np.argsort(pre, kind='stable')
        pre, post, weight = pre[order], post[order], weight[order]
        indptr = np.zeros(n + 1, dtype=np.int64)
        np.cumsum(np.bincount(pre, minlength=n), out=indptr[1:])
        return cls(n, indptr, post, weight)

    def silence(self, idx):
        """Met a zero toutes les synapses entrantes et sortantes de `idx`."""
        if len(idx) == 0:
            return self
        w = self.weights.copy()
        idx = np.asarray(idx, dtype=np.int64)
        for i in idx:                                   # sortantes
            w[self.indptr[i]:self.indptr[i + 1]] = 0.0
        mask = np.zeros(self.n, dtype=bool)             # entrantes
        mask[idx] = True
        w[mask[self.indices]] = 0.0
        return Connectome(self.n, self.indptr, self.indices, w)

    def nnz(self):
        return len(self.indices)


def simulate(conn, stim, duration_s=1.0, params=None, seed=0, silenced=None,
             progress=None):
    """
    Lance une experience.

    conn      : Connectome
    stim      : liste de (indices, taux_hz) -- les groupes stimules
    duration_s: duree simulee en secondes
    silenced  : indices de neurones a eteindre
    seed      : graine du generateur (l'entree est stochastique)

    Retourne (steps, neurones) : deux tableaux paralleles, un element par spike.
    """
    p = dict(DEFAULT_PARAMS)
    if params:
        p.update(params)

    if silenced is not None and len(silenced):
        conn = conn.silence(silenced)

    n = conn.n
    rng = np.random.default_rng(seed)
    n_steps = int(round(duration_s * 1000.0 / DT_MS))

    steps_delay = int(p['t_delay'] / DT_MS)          # 18
    refrac_steps_default = int(round(p['t_rfc'] / DT_MS))  # 22
    buf_len = steps_delay + 1

    # taux de Poisson par neurone (Hz) et exemption de refractaire pour les stimules
    rates = np.zeros(n, dtype=np.float32)
    refrac_steps = np.full(n, refrac_steps_default, dtype=np.int32)
    for idx, hz in stim:
        idx = np.asarray(idx, dtype=np.int64)
        rates[idx] = hz
        refrac_steps[idx] = 0
    stim_idx = np.flatnonzero(rates > 0)
    stim_prob = (rates[stim_idx] * (DT_MS / 1000.0)).astype(np.float64)

    v = np.full(n, p['v_rest'], dtype=np.float32)
    g = np.zeros(n, dtype=np.float32)
    refrac = refrac_steps.astype(np.int32).copy()
    spikes = np.zeros(n, dtype=bool)
    delay_buf = np.zeros((buf_len, n), dtype=np.float32)
    head = 0

    decay_syn = np.float32(1.0 - DT_MS / p['tau_syn'])
    k_mem = np.float32(DT_MS / p['tau_mem'])
    v_rest = np.float32(p['v_rest'])
    v_th = np.float32(p['v_th'])
    v_reset = np.float32(p['v_reset'])
    w_syn = np.float32(p['w_syn'])
    stim_amp = np.float32(p['w_syn'] * p['f_poi'])

    indptr, indices, weights = conn.indptr, conn.indices, conn.weights
    out_steps, out_neurons = [], []

    for step in range(n_steps):
        # --- propagation des spikes du pas precedent -------------------------
        rec = np.zeros(n, dtype=np.float32)
        fired = np.flatnonzero(spikes)
        if fired.size:
            starts, ends = indptr[fired], indptr[fired + 1]
            counts = ends - starts
            total = int(counts.sum())
            if total:
                offsets = np.repeat(starts, counts) + (
                    np.arange(total, dtype=np.int64)
                    - np.repeat(np.cumsum(counts) - counts, counts)
                )
                rec = np.bincount(
                    indices[offsets], weights=weights[offsets], minlength=n
                ).astype(np.float32)
                rec *= w_syn

        # --- refractaire : compteur depuis le dernier spike -------------------
        refrac = np.where(spikes, 0, refrac + 1)
        active = refrac >= refrac_steps

        # --- conductance : decroissance + entree retardee, portillonnee -------
        g_new = g * decay_syn + delay_buf[head] * active
        delay_buf[head] = rec
        head = (head + 1) % buf_len

        # --- stimulation de Poisson (optogenetique virtuelle) -----------------
        v_stim = np.zeros(n, dtype=np.float32)
        if stim_idx.size:
            hits = rng.random(stim_idx.size) < stim_prob
            v_stim[stim_idx] = hits * stim_amp

        # --- membrane : utilise l'ANCIENNE conductance (comme la reference) ---
        v += v_stim
        v += k_mem * (g - (v - v_rest))

        spikes = v > v_th
        if spikes.any():
            v[spikes] = v_reset
            g_new[spikes] = 0.0
            fired_now = np.flatnonzero(spikes)
            out_steps.append(np.full(fired_now.size, step, dtype=np.int32))
            out_neurons.append(fired_now.astype(np.int32))

        g = g_new

        if progress and step % progress == 0:
            print(f'    pas {step:>7,}/{n_steps:,}', end='\r', flush=True)

    if progress:
        print(' ' * 40, end='\r')

    if not out_steps:
        return np.empty(0, np.int32), np.empty(0, np.int32)
    return np.concatenate(out_steps), np.concatenate(out_neurons)
