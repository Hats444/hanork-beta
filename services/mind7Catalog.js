'use strict';
// Catalogo Mind7 (painel mind-7.org). Sem PII. Sem gerar chave PIX.

const MODULES = [
  {
    id: 'cpf',
    cmds: ['cpffull', 'cpfbd', 'dossie'],
    path: 'cpf',
    desc: 'Dossie completo (parentes, enderecos, empregos)',
    usage: 'cpffull <11 digitos> [bigdata|search|saude|nacional]',
    need: 'cpf',
    cat: 'pessoal',
    primary: 'documento',
    endpoint: (f) => `${f.tipo_consulta || 'bigdata'}.php`,
    extra: { tipo_consulta: 'bigdata', termos_aceitos: 'on' },
    aliasesArg: { tipo: 'tipo_consulta' }
  },
  {
    id: 'nome',
    cmds: ['buscanome'],
    path: 'nome',
    desc: 'Busca CPF pelo nome (filtros mae/uf/cidade)',
    usage: 'buscanome <nome completo> [mae:Maria] [uf:SP] [cidade:SaoPaulo]',
    need: 'nome',
    cat: 'pessoal',
    primary: 'q',
    extra: {},
    aliasesArg: { mae: 'mae', uf: 'uf', cidade: 'cidade', bairro: 'bairro', cep: 'cep' }
  },
  {
    id: 'nome_v2',
    cmds: ['nomeabreviado', 'nomev2', 'buscanome2'],
    path: 'nome_v2',
    desc: 'Busca por nome completo ou abreviado',
    usage: 'nomeabreviado <nome> [mae:Maria] [uf:SP]',
    need: 'nome',
    cat: 'pessoal',
    primary: 'nome',
    extra: {},
    aliasesArg: { mae: 'nome_mae', uf: 'uf', cidade: 'cidade', nasc: 'dt_nascimento' }
  },
  {
    id: 'celular',
    cmds: ['celular', 'fonecadastro'],
    path: 'celular',
    desc: 'Cadastros pelo celular (dossie)',
    usage: 'celular <ddd+numero> [celular|telefone]',
    need: 'tel',
    cat: 'contato',
    primary: 'documento',
    extra: { tipo_consulta: 'celular' },
    aliasesArg: { tipo: 'tipo_consulta' }
  },
  {
    id: 'parentes',
    cmds: ['parentes', 'familia'],
    path: 'parentes',
    desc: 'Parentes pelo CPF',
    usage: 'parentes <cpf>',
    need: 'cpf',
    cat: 'pessoal',
    primary: 'documento',
    extra: { base: 'search' }
  },
  {
    id: 'mae',
    cmds: ['mae', 'filhos'],
    path: 'mae',
    desc: 'Filhos pelo nome da mae',
    usage: 'mae <nome da mae> [filho:Joao] [uf:SP]',
    need: 'nome',
    cat: 'pessoal',
    primary: 'mae',
    extra: {},
    aliasesArg: { filho: 'q', uf: 'uf', cidade: 'cidade', cep: 'cep' }
  },
  {
    id: 'nascimento',
    cmds: ['nascimento', 'nasc'],
    path: 'nascimento',
    desc: 'Localiza por data de nascimento e nome',
    usage: 'nascimento <nome> nasc:DD/MM/AAAA [uf:SP]',
    need: 'nome',
    cat: 'pessoal',
    primary: 'q',
    extra: { nasc_modo: 'data' },
    aliasesArg: { nasc: 'nascimento', uf: 'uf', cidade: 'cidade' }
  },
  {
    id: 'inss',
    cmds: ['inss'],
    path: 'inss',
    desc: 'Aposentados e pensionistas INSS pelo CPF',
    usage: 'inss <cpf>',
    need: 'cpf',
    cat: 'pessoal',
    primary: 'documento',
    extra: { base: 'search' }
  },
  {
    id: 'score',
    cmds: ['score'],
    path: 'score',
    desc: 'Score e faixa de risco pelo CPF',
    usage: 'score <cpf>',
    need: 'cpf',
    cat: 'pessoal',
    primary: 'documento',
    extra: { base: 'search' }
  },
  {
    id: 'saude',
    cmds: ['saude', 'cns'],
    path: 'saude',
    desc: 'Saude/SUS pelo CPF (CNS no painel esta OFF)',
    usage: 'saude <cpf>',
    need: 'cpf',
    cat: 'pessoal',
    primary: 'documento',
    extra: { tipo: 'cpf' }
  },
  {
    id: 'receita',
    cmds: ['receita', 'receitafederal'],
    path: 'receita',
    desc: 'Receita Federal pelo CPF',
    usage: 'receita <cpf>',
    need: 'cpf',
    cat: 'pessoal',
    primary: 'documento',
    extra: { base: 'search' }
  },
  {
    id: 'fotos',
    cmds: ['fotos', 'fotocpf'],
    path: 'fotos',
    desc: 'Foto cadastral pelo CPF',
    usage: 'fotos <cpf>',
    need: 'cpf',
    cat: 'pessoal',
    primary: 'documento',
    extra: { base: 'search' }
  },
  {
    id: 'foto_cnh',
    cmds: ['fotocnh'],
    path: 'foto_cnh',
    desc: 'Foto e dados da CNH pelo CPF (pago apos 1 gratis/dia)',
    usage: 'fotocnh <cpf>',
    need: 'cpf',
    cat: 'pessoal',
    primary: 'documento',
    extra: { base: 'search' }
  },
  {
    id: 'foto_mg',
    cmds: ['fotocnhmg', 'fotomg'],
    path: 'foto_mg',
    desc: 'Foto e assinatura CNH MG pelo CPF',
    usage: 'fotocnhmg <cpf>',
    need: 'cpf',
    cat: 'pessoal',
    primary: 'documento',
    extra: { base: 'search' }
  },
  {
    id: 'foto_sc',
    cmds: ['fotocnhsc', 'fotosc'],
    path: 'foto_sc',
    desc: 'Foto RG/CNH SC pelo CPF',
    usage: 'fotocnhsc <cpf>',
    need: 'cpf',
    cat: 'pessoal',
    primary: 'documento',
    extra: { base: 'search' }
  },
  {
    id: 'cnh',
    cmds: ['cnh'],
    path: 'cnh',
    desc: 'CNH (pontuacao, validade, categoria) pelo CPF',
    usage: 'cnh <cpf>',
    need: 'cpf',
    cat: 'pessoal',
    primary: 'documento',
    extra: { base: 'search', tipo: 'cpf' }
  },
  {
    id: 'titulo',
    cmds: ['titulo', 'tse'],
    path: 'titulo',
    desc: 'Titulo de eleitor pelo CPF',
    usage: 'titulo <cpf>',
    need: 'cpf',
    cat: 'pessoal',
    primary: 'documento',
    extra: { tipo_consulta: 'search' }
  },
  {
    id: 'email_mind',
    cmds: ['donoemail', 'emailmind'],
    path: 'email',
    desc: 'Dono do e-mail (cadastro)',
    usage: 'donoemail <email>',
    need: 'email',
    cat: 'contato',
    primary: 'email'
  },
  {
    id: 'pix',
    cmds: ['consultapix', 'chavepix'],
    path: 'pix',
    desc: 'Consulta chave PIX (CPF, e-mail, tel ou aleatoria)',
    usage: 'consultapix <chave>',
    need: 'text',
    cat: 'contato',
    primary: 'documento'
  },
  {
    id: 'decrifar_pix',
    cmds: ['decrifarpix', 'decodificapix'],
    path: 'decrifar_pix',
    desc: 'Identifica pelo comprovante PIX (nome + trecho da chave)',
    usage: 'decrifarpix <nome> chave:*111.222*',
    need: 'nome',
    cat: 'contato',
    primary: 'nome',
    extra: {},
    aliasesArg: { chave: 'documento', pix: 'documento' }
  },
  {
    id: 'placa',
    cmds: ['placafull', 'placadetran'],
    path: 'placa',
    desc: 'Consulta veicular completa pela placa',
    usage: 'placafull <ABC1D23>',
    need: 'placa',
    cat: 'veiculo',
    primary: 'documento',
    extra: { base: 'placa', tipo: 'placa' }
  },
  {
    id: 'placapro',
    cmds: ['placapro', 'radarpro'],
    path: 'placapro',
    desc: 'Placa Pro / radar (historico de passagens)',
    usage: 'placapro <ABC1D23>',
    need: 'placa',
    cat: 'veiculo',
    primary: 'documento',
    extra: { base: 'placa', tipo: 'placa' }
  },
  {
    id: 'chassi',
    cmds: ['chassi'],
    path: 'chassi',
    desc: 'Consulta veicular por chassi',
    usage: 'chassi <17 caracteres>',
    need: 'chassi',
    cat: 'veiculo',
    primary: 'documento',
    extra: { base: 'search' }
  },
  {
    id: 'renavam',
    cmds: ['renavam'],
    path: 'renavam',
    desc: 'Consulta por RENAVAM',
    usage: 'renavam <numero>',
    need: 'digits',
    cat: 'veiculo',
    primary: 'documento',
    extra: { base: 'search' }
  },
  {
    id: 'crlv',
    cmds: ['crlv', 'crlve'],
    path: 'crlv',
    desc: 'CRLV-e em PDF (gratis 3/dia, depois pago)',
    usage: 'crlv <placa>',
    need: 'placa',
    cat: 'veiculo',
    primary: 'documento',
    extra: { base: 'search', tipo: 'placa' }
  },
  {
    id: 'multas',
    cmds: ['multas'],
    path: 'multas',
    desc: 'Multas nacionais por placa (pago)',
    usage: 'multas <placa>',
    need: 'placa',
    cat: 'veiculo',
    primary: 'documento',
    extra: { base: 'search', tipo: 'placa' }
  },
  {
    id: 'detranmg',
    cmds: ['detranmg'],
    path: 'detranmg',
    desc: 'DETRAN MG (placa ou CPF)',
    usage: 'detranmg <placa|cpf>',
    need: 'text',
    cat: 'veiculo',
    primary: 'documento',
    extra: { base: 'detranmg', tipo: 'placa' },
    endpoint: () => 'detranmg.php'
  },
  {
    id: 'detransp',
    cmds: ['detransp'],
    path: 'detransp',
    desc: 'DETRAN SP (condutor, frota, posse) pelo CPF',
    usage: 'detransp <cpf>',
    need: 'cpf',
    cat: 'veiculo',
    primary: 'documento',
    extra: { base: 'search', tipo: 'cpf' }
  },
  {
    id: 'frota',
    cmds: ['frota'],
    path: 'frota',
    desc: 'Veiculos vinculados ao CPF/CNPJ',
    usage: 'frota <cpf|cnpj>',
    need: 'doc',
    cat: 'veiculo',
    primary: 'documento',
    extra: { base: 'search', tipo: 'placa' }
  },
  {
    id: 'cnpj_mind',
    cmds: ['cnpjfull', 'cnpjmind'],
    path: 'cnpj',
    desc: 'CNPJ completo (quadro societario)',
    usage: 'cnpjfull <14 digitos>',
    need: 'cnpj',
    cat: 'empresa',
    primary: 'documento',
    extra: { base: 'search' }
  },
  {
    id: 'emprego',
    cmds: ['emprego'],
    path: 'emprego',
    desc: 'Historico de empregos e sociedades (CPF ou CNPJ)',
    usage: 'emprego <cpf|cnpj>',
    need: 'doc',
    cat: 'empresa',
    primary: 'documento',
    extra: { base: 'search' }
  },
  {
    id: 'relacao_emprego',
    cmds: ['relacaoemprego', 'colegas'],
    path: 'relacao_emprego',
    desc: 'Colegas de trabalho pelo CPF',
    usage: 'relacaoemprego <cpf>',
    need: 'cpf',
    cat: 'empresa',
    primary: 'documento',
    extra: { base: 'search', tipo: 'cpf' }
  },
  {
    id: 'dividas',
    cmds: ['dividas', 'serasa'],
    path: 'dividas',
    desc: 'Serasa/dividas (CPF ou CNPJ) — modulo pago',
    usage: 'dividas <cpf|cnpj>',
    need: 'doc',
    cat: 'empresa',
    primary: 'documento',
    extra: { base: 'search' }
  },
  {
    id: 'cloud',
    cmds: ['vazamentos', 'leaks'],
    path: 'cloud',
    desc: 'Vazamentos por URL, e-mail, user ou IP',
    usage: 'vazamentos <email|url|user> [tipo:email|url|username|ip]',
    need: 'text',
    cat: 'outros',
    primary: 'documento',
    extra: { tipo: 'email' },
    aliasesArg: { tipo: 'tipo' }
  },
  {
    id: 'cep_mind',
    cmds: ['moradores', 'cepresidentes'],
    path: 'cep',
    desc: 'Residentes pelo CEP',
    usage: 'moradores <8 digitos> [nome:Joao] [numero:153]',
    need: 'cep',
    cat: 'local',
    primary: 'cep',
    extra: {},
    aliasesArg: { nome: 'q', numero: 'numero' }
  },
  {
    id: 'processos2',
    cmds: ['processos', 'processos2'],
    path: 'processos2',
    desc: 'Processos judiciais (painel avisou indisponivel)',
    usage: 'processos <cpf|cnpj>',
    need: 'doc',
    cat: 'outros',
    primary: 'documento',
    extra: { base: 'search', tipo: 'cpf', forcar: '1' },
    unavailable: true
  },
  {
    id: 'leads_pf',
    cmds: ['leadspf', 'listapessoas'],
    path: 'leads_pf',
    desc: 'Lista segmentada de pessoas (estado, cidade, renda...)',
    usage: 'leadspf uf:SP cidade:SaoPaulo [sexo:M] [idade_min:25]',
    need: 'kv',
    cat: 'outros',
    primary: 'profissoes',
    extra: {}
  },
  {
    id: 'leads_pj',
    cmds: ['leadspj', 'listaempresas'],
    path: 'leads_pj',
    desc: 'Lista de empresas por atividade, UF e cidade',
    usage: 'leadspj <atividade> uf:SP',
    need: 'text',
    cat: 'empresa',
    primary: 'cnae',
    extra: { situacao: '2' },
    aliasesArg: { uf: 'uf', cidade: 'cidade' }
  },
  {
    id: 'tempmail',
    cmds: ['tempmail'],
    path: '../tempmail',
    desc: 'E-mail descartavel (painel Ferramentas)',
    usage: 'tempmail [nome] [domain:x]',
    need: 'optional',
    cat: 'outros',
    primary: 'name',
    extra: {},
    tool: true
  }
];

const BY_CMD = new Map();
for (const mod of MODULES) {
  for (const c of mod.cmds) BY_CMD.set(String(c).toLowerCase(), mod);
}

function getModule(name) {
  return BY_CMD.get(String(name || '').toLowerCase().trim()) || null;
}

function allCommandNames() {
  return [...BY_CMD.keys()];
}

function menuLines(prefix) {
  const p = prefix || '.';
  const cats = {
    pessoal: 'Pessoa fisica',
    contato: 'Contato',
    veiculo: 'Veicular',
    empresa: 'Empresas',
    local: 'Localizacao',
    outros: 'Outros'
  };
  const lines = [];
  for (const [cat, label] of Object.entries(cats)) {
    const items = MODULES.filter((m) => m.cat === cat && !m.unavailable);
    if (!items.length) continue;
    lines.push(label);
    for (const m of items) {
      const cmd = m.cmds[0];
      const usage = m.usage || cmd;
      const desc = String(m.desc || '').trim();
      lines.push(desc ? `  ${p}${usage} — ${desc}` : `  ${p}${usage}`);
    }
    lines.push('');
  }
  lines.push('Processos: painel avisou indisponivel.');
  lines.push('Nao gera chave PIX (so consulta chave existente).');
  return lines;
}

module.exports = {
  MODULES,
  getModule,
  allCommandNames,
  menuLines
};
