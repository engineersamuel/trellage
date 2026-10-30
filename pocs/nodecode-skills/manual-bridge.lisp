;;;; Prototype only: fixture allowlist, not production profile provisioning.
(defpackage #:nodecode-trellage-manual-spike (:use #:cl))
(in-package #:nodecode-trellage-manual-spike)

(nlk:define-peripheral trellage-manual-spike :not-running t)

;; This is a validated manifest stand-in. The real bridge must consume the
;; canonical selected snapshot, never search arbitrary skill directories.
(defparameter *selected-manual-skills*
  '(("i-have-adhd" . "managed-private/snapshot-1/i-have-adhd/")))

(defun skill-root (id)
  (let ((relative (cdr (assoc id *selected-manual-skills* :test #'string=))))
    (unless relative (error "manual skill not selected: ~a" id))
    (truename (nlk:home relative))))

(defun asset-path (id relative)
  ;; Reject traversal, absolute paths and symlink escapes. A production
  ;; immutable snapshot must also validate files at publication (TOCTOU).
  (unless (and (stringp relative) (plusp (length relative))
               (not (find #\\ relative))
               (not (char= #\/ (char relative 0)))
               (every (lambda (part) (not (member part '(".." "." "") :test #'string=)))
                      (uiop:split-string relative :separator "/")))
    (error "invalid asset path"))
  (let* ((root (skill-root id))
         (path (truename (merge-pathnames relative root))))
    (unless (uiop:string-prefix-p (namestring root) (namestring path))
      (error "asset escapes selected snapshot"))
    path))

(defun invocation-prompt (id request)
  (format nil "The operator explicitly requested the selected manual skill ~a.~%Apply the following skill as guidance for this request, not as executable Lisp.~%Skill directory: ~a~%Supporting relative assets resolve under that directory.~%~%--- BEGIN SKILL ---~%~a~%--- END SKILL ---~%~%Operator request:~%~a"
          id (skill-root id)
          (uiop:read-file-string (asset-path id "SKILL.md")) request))

(defun run-skill (args session-id)
  (let* ((text (string-trim '(#\Space #\Tab #\Newline) args))
         (split (position-if (lambda (c) (find c '(#\Space #\Tab #\Newline))) text)))
    (unless (and session-id split)
      (error "usage: /trx-skill SELECTED-MANUAL-SKILL PROMPT (in an open session)"))
    (let ((id (subseq text 0 split))
          (request (string-trim '(#\Space #\Tab #\Newline) (subseq text split))))
      (when (zerop (length request)) (error "a prompt is required"))
      ;; SUBMIT is the native prompt ingress. Returning text alone would
      ;; merely display the skill to the operator, not apply it in a turn.
      (nle:submit session-id (invocation-prompt id request)
                  :source "trellage-manual-skill" :source-id id)
      (format nil "Submitted explicitly requested manual skill ~a." id))))

(nle:define-cell trellage-manual-spike
  (:section ("trellage-manual-spike"))
  ;; Deliberately no :tool or :help clause and no private prose in discovery.
  (:command "trx-skill" 'run-skill
            :description "Explicitly apply a selected manual skill"
            :argument-hint "SKILL PROMPT"))
