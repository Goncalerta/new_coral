laraImport("lara.pass.Pass");

laraImport("coral.borrowck.RegionVariable");
laraImport("coral.borrowck.RegionKind");

laraImport("coral.ty.Ty");
laraImport("coral.ty.RefTy");
laraImport("coral.ty.BuiltinTy");
laraImport("coral.ty.ElaboratedTy");
laraImport("coral.ty.BorrowKind");

laraImport("coral.borrowck.Regionck");

laraImport("coral.mir.path.PathVarRef");
laraImport("coral.mir.path.PathMemberAccess");
laraImport("coral.mir.path.PathDeref");
laraImport("coral.mir.path.PathKind");

laraImport("coral.mir.Loan");
laraImport("coral.mir.Access");

laraImport("coral.mir.StatementAction");
laraImport("coral.mir.StatementActionKind");

class CfgAnnotator extends Pass {

    /**
     * @type {Regionck}
     */
    regionck;

    /**
     * @type {number}
     */
    regionVarCounter;
    /**
     * @type {FnLifetimes}
     */
    fnLifetimes;

    constructor(regionck) {
        super();
        this.regionck = regionck;
    }

    #new_region_var($expr, name="", kind=RegionKind.EXISTENTIAL) {
        const id = this.regionVarCounter++;
        const rvar = new RegionVariable(
            id,
            kind,
            name === "" ? id.toString() : name,
            $expr
        );
        this.regionck.regions.push(rvar);
        return rvar;
    }

    /**
     * Apply tranformation to
     * @param {JoinPoint} $jp Joint point on which the pass will be applied
     * @return {PassResult} Results of applying this pass to the given joint point
     */
    _apply_impl($jp) {
        // Init scratch pad and annotate nodes with liveness
        for (const node of this.regionck.cfg.graph.nodes()) {
            const scratch = {};
            scratch.liveIn = this.regionck.liveness.liveIn.get(node.id()) ?? new Set();
            scratch.liveOut = this.regionck.liveness.liveOut.get(node.id()) ?? new Set();
            scratch.accesses = [];
            scratch.inScopeLoans = [];
            scratch.copies = [];
            scratch.moves = [];

            node.scratch("_coral", scratch);
        }

        this.regionVarCounter = 1;
        this.#createUniversalRegions($jp);
        this.#annotateLifetimeTypes();
        delete this.fnLifetimes;
    }

    #createUniversalRegions($jp) {
        this.fnLifetimes = new FnLifetimes($jp);
        this.regionck.regions.push(new RegionVariable(0, RegionKind.UNIVERSAL, "static", undefined));
        
        // Annotate param universal regions
        for (const $param of $jp.params) {
            const ty = this.#deconstructType($param.type, $param, false);
            $param.setUserField("ty", ty);
            this.borrowck.declarations.set($param.name, ty);

            // TODO: Retrieve lifetimes from fnLifetimes
            // & Create multiple regionVars if needed

            const regionVar = this.#new_region_var($param);
            this.regionck.regions.push(regionVar);
        }
    }

    #annotateLifetimeTypes() {
        for (const node of this.regionck.cfg.graph.nodes()) {
            const data = node.data();

            switch (data.type) {
                case CfgNodeType.INST_LIST: {
                    const $stmt = data.stmts[0];
                    switch ($stmt.joinPointType) {
                        case "declStmt":
                            this.#annotateDeclStmt(node, $stmt.children[0]);
                            break;
                        case "exprStmt":
                            this.#annotateExprStmt(node, $stmt.children[0]);
                            break;
                        case "wrapperStmt":
                            this.#annotateWrapperStmt(node, $stmt.children[0]);
                    }
                    break;
                }
                case CfgNodeType.IF:
                    this.#annotateExprStmt(node, data.nodeStmt.cond);
                    break;
                case CfgNodeType.RETURN:
                    this.#annotateExprStmt(node, data.nodeStmt);
                    break;
                case CfgNodeType.SWITCH:
                    throw new Error("Unimplemented: Switch annotation");
            }
        }
    }


    #annotateDeclStmt(node, $vardecl) {
        const ty = this.#deconstructType($vardecl.type, $vardecl, true);        
        $vardecl.setUserField("ty", ty);
        const scratch = node.scratch("_coral");
        scratch.lhs = $vardecl;
        scratch.lhs_ty = ty;
        this.regionck.declarations.set($vardecl.name, ty);

        if ($vardecl.hasInit) {
            scratch.accesses.push(new Access(
                new PathVarRef($vardecl, undefined),
                AccessMutability.WRITE,
                AccessDepth.SHALLOW
            ));

            this.#annotateExprStmt(node, $vardecl.init);
        }
    }

    #deconstructType($type, $jp, create_region_var=false) {        
        let isConst = false;
        let isRestrict = false;

        if ($type.instanceOf("qualType")) {
            if ($type.qualifiers.includes("const"))
                isConst = true;
            if ($type.qualifiers.includes("restrict"))
                isRestrict = true;
            $type = $type.unqualifiedType;
        }


        switch ($type.joinPointType) {
            case "builtinType":
                return new BuiltinTy($type.builtinKind, isConst);
            case "pointerType": {
                const inner = this.#deconstructType($type.pointee, $jp, create_region_var);
                if (inner.isConst && isRestrict)
                    throw new Error("Cannot have a restrict pointer to a const type");

                return new RefTy(
                    inner.isConst ? BorrowKind.SHARED : BorrowKind.MUTABLE,
                    inner,
                    create_region_var ? this.#new_region_var($jp) : undefined,
                    isConst
                );
            }
            case "qualType":
                throw new Error("Unreachable: QualType cannot have a QualType as unqualified type");
            case "typedefType":
                return this.#deconstructType($type.underlyingType, $jp, create_region_var);
            case "elaboratedType":
                // Inner should be instance of TagType, inner is 
                // println($type.joinPointType);
                // println($type.qualifier);
                // println($type.keyword);
                // println("------------------");  

                // println($type.namedType.joinPointType);
                // println($type.namedType.kind);
                // println($type.namedType.name);
                // println("------------------");

                // println($type.namedType.decl.joinPointType);
                // println($type.namedType.decl.kind);
                throw new Error("Unimplemented Elaborated type annotation");
            default:
                throw new Error("Unhandled deconstruct declstmt type: " + $type.joinPointType);

        }
    }


    #annotateExprStmt(node, $exprStmt) {
        switch ($exprStmt.joinPointType) {
            case "literal":
            case "intLiteral":
            case "floatLiteral":
            case "boolLiteral":
                break;
            case "binaryOp":
                this.#annotateBinaryOp(node, $exprStmt);
                break;
            case "unaryOp":
                this.#annotateUnaryOp(node, $exprStmt);
                break;
            case "call":
                this.#annotateFunctionCall(node, $exprStmt);
                break;
            case "varref": {
                const path = this.#parseLvalue(node, $exprStmt);
                const ty = $exprStmt.declaration.userField("ty");
                // TODO: DEEP WRITE only if moving value, should be implemented, but needs testing due to edge cases
                node.scratch("_coral").accesses.push(new Access(
                    path,
                    ty.isCopyable ? AccessMutability.READ : AccessMutability.WRITE,
                    AccessDepth.DEEP
                ));
                break;
            }
            case "parenExpr":
                throw new Error("Unimplemented: Paren expr annotation");
            case "returnStmt":
                this.#annotateExprStmt(node, $exprStmt.returnExpr);
                break;
            default:
                println("Unhandled expression annotation for jp: " + $exprStmt.joinPointType);
        }
    }

    
    #annotateBinaryOp(node, $binaryOp) {
        if ($binaryOp.isAssignment) {
            const path = this.#parseLvalue(node, $binaryOp.left);
            const scratch = node.scratch("_coral");
            scratch.accesses.push(new Access(path, AccessMutability.WRITE, AccessDepth.SHALLOW));
            
            this.#annotateExprStmt(node, $binaryOp.right);
            
            // Identify & mark moves, only if the right side is path
            // TODO: Not detecting "a = (b);"
            if ($binaryOp.right.instanceOf("varref") ||
                    ( $binaryOp.right.instanceOf("unaryOp") &&
                    $binaryOp.right.operator === "*" ) ) {
                // May be a move
                const leftPath = this.#parseLvalue(node, $binaryOp.left);
                const leftTy = this.regionck.declarations.get($binaryOp.left.name);
                const rightPath = this.#parseLvalue(node, $binaryOp.right);
                const rightTy = rightPath.retrieveTy(this.regionck);
                if (leftTy.isCopyable !== rightTy.isCopyable) {
                    throw new Error("AnnotateBinaryOp: Incompatible types");
                }
                const statementAction = new StatementAction(
                    leftTy.isCopyable ? StatementActionKind.COPY : StatementActionKind.MOVE,
                    leftPath,
                    rightPath,
                    leftTy,
                    rightTy
                );
                if (leftTy.isCopyable)
                    scratch.copies.push(statementAction);
                else
                    scratch.moves.push(statementAction);
            }

            
            return;
        }

        this.#annotateExprStmt(node, $binaryOp.left);
        this.#annotateExprStmt(node, $binaryOp.right);
    }


    #annotateUnaryOp(node, $unaryOp) {
        if ($unaryOp.operator === "&") {
            // Create loan, and start of an lvalue
            const loanedPath = this.#parseLvalue(node, $unaryOp.operand);
            const regionVar = this.#new_region_var($unaryOp);
            const loanedTy = loanedPath.retrieveTy(this.regionck);

            // Borrowkind depends on the assignment left value
            let assignment = $unaryOp.parent;
            while (assignment.joinPointType !== "binaryOp" || !assignment.isAssignment) {
                assignment = assignment.parent;
            }

            const leftTy = this.#parseLvalue(node, assignment.left).retrieveTy(this.regionck);
            if (!(leftTy instanceof RefTy)) {
                throw new Error("annotateUnaryOp: Cannot borrow from non-reference type " + leftTy.toString());
            }

            const loan = new Loan(regionVar, leftTy, loanedTy, loanedPath, $unaryOp);
            node.scratch("_coral").loan = loan;
            this.regionck.loans.push(loan);

            node.scratch("_coral").accesses.push(new Access(
                loanedPath,
                loan.borrowKind === BorrowKind.MUTABLE ? AccessMutability.WRITE : AccessMutability.READ,
                AccessDepth.DEEP
            ));

            // TODO: I think I'm missing something here
        } else if ($unaryOp.operator === "*") {
            // Start of an lvaue
            const path = this.#parseLvalue(node, $unaryOp);
            // TODO: Set correct AccessMutability and AccessDepth
            node.scratch("_coral").accesses.push(new Access(
                path,
                AccessMutability.READ,
                AccessDepth.DEEP
            ));
        } else {
            // Not relevant, keep going
            this.#annotateExprStmt(node, $unaryOp.operand);
        }
    }


    #annotateFunctionCall(node, $call) {
        for (const $expr of $call.args) {
            const path = this.#parseLvalue(node, $expr);
            // TODO: Set correct AccessMutability and AccessDepth
            node.scratch("_coral").accesses.push(new Access(
                path,
                AccessMutability.READ,
                AccessDepth.DEEP
            ));
            // TODO: Identify & mark moves
        }
    }


    #annotateWrapperStmt(node, $wrapperStmt) {
        println("TODO: Wrapper stmt annotation");
    }





    //--------------------------------
    /**
     * 
     * @param {*} node 
     * @param {JoinPoint} $jp 
     * @returns {Path}
     */
    #parseLvalue(node, $jp) {
        switch ($jp.joinPointType) {
            case "literal":
            case "intLiteral":
            case "floatLiteral":
            case "boolLiteral":
                return undefined;
            case "varref":
                return new PathVarRef($jp, undefined);
            case "unaryOp":
                if ($jp.operator === "*")
                    return new PathDeref($jp, this.#parseLvalue(node, $jp.operand));
                else
                    throw new Error("Unhandled parseLvalue unary op: " + $jp.operator);
            case "memberAccess":
            case "parenExpr":
                return this.#parseLvalue(node, $jp.subExpr);
            default:
                throw new Error("Unhandled parseLvalue: " + $jp.joinPointType);
        }   
    }
}